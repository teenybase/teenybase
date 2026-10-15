import {SELF} from "cloudflare:test";
import {beforeAll, describe, expect, test} from "vitest";
import {setup} from '../data/drive2/setup'
import {DatabaseSettings} from '../../src'

// Default-deny (relaunch Q1): a table with no rules extension rejects anonymous and signed-in CRUD;
// admin / service-token requests still work; `public: true` restores the old fully-open behaviour.
// drive_config is used with its rules extension stripped. users keeps its rules, so sign-up works.

type Settings = DatabaseSettings
let base: Settings
let userToken: string
const ADMIN = 'test_admin_service_token' // ADMIN_SERVICE_TOKEN in vitest.config.ts

function withDriveConfig(patch: Record<string, any>): Settings {
    const s = structuredClone(base)
    const t = s.tables.find(t => t.name === 'drive_config')!
    t.extensions = t.extensions.filter(e => e.name !== 'rules')
    Object.assign(t, patch)
    return s
}

const call = (settings: Settings, path: string, init: RequestInit = {}, token?: string) => {
    const headers: Record<string, string> = {
        '$DB_TEST_DATABASE_SETTINGS': JSON.stringify(settings),
        'Content-Type': init.method === 'POST' ? 'application/json' : 'text/plain',
    }
    if (token) headers['Authorization'] = 'Bearer ' + token
    return SELF.fetch('https://example.com/api/v1/' + path, {...init, headers})
}

const post = (body: any): RequestInit => ({method: 'POST', body: JSON.stringify(body)})

// Every CRUD route on drive_config. Each id/value is unique per call so a request that unexpectedly
// succeeds cannot be masked by an earlier one.
let n = 0
const crud = () => {
    const id = 'dd-' + (++n)
    return {
        list: ['table/drive_config/select?select=id,val', {}] as const,
        view: ['table/drive_config/view/app-name', {}] as const,
        insert: ['table/drive_config/insert', post({values: {id, val: 'x'}, returning: ['id']})] as const,
        update: ['table/drive_config/update', post({set: {val: '"y"'}, where: `id = 'logo'`, returning: ['id']})] as const,
        edit: ['table/drive_config/edit/favicon', post({val: 'z'})] as const,
        delete: ['table/drive_config/delete', post({where: `id = 'language'`, returning: ['id']})] as const,
    }
}

beforeAll(async () => {
    base = await setup() as unknown as Settings // setup() returns the generated config as a deep-readonly literal
    const res = await call(base, 'table/users/auth/sign-up', post({
        username: 'regular', email: 'regular@example.com', password: '12345678', passwordConfirm: '12345678',
        name: 'Regular', meta: '{"base": "/"}',
    }))
    expect(res.status).toEqual(200)
    userToken = ((await res.json()) as any).token
    expect(userToken).toBeTruthy()
})

describe('table without rules (default-deny)', () => {
    test.each(['list', 'view', 'insert', 'update', 'edit', 'delete'] as const)('anonymous %s is rejected', async (op) => {
        const [path, init] = crud()[op]
        const res = await call(withDriveConfig({}), path, init)
        expect(res.status).toEqual(403)
        expect(((await res.json()) as any).message).toEqual('Forbidden')
    })

    test.each(['list', 'view', 'insert', 'update', 'edit', 'delete'] as const)('signed-in user %s is rejected', async (op) => {
        const [path, init] = crud()[op]
        const res = await call(withDriveConfig({}), path, init, userToken)
        expect(res.status).toEqual(403)
    })

    test('public: false is the same as omitting it', async () => {
        const [path, init] = crud().list
        const res = await call(withDriveConfig({public: false}), path, init)
        expect(res.status).toEqual(403)
    })

    test('nothing was written by the rejected requests', async () => {
        const res = await call(withDriveConfig({}), 'table/drive_config/select?select=id,val&where=' + encodeURIComponent(`id ~ 'dd-%' | id = 'logo' | id = 'favicon' | id = 'language'`), {}, ADMIN)
        expect(res.status).toEqual(200)
        expect(await res.json()).toEqual([
            {id: 'logo', val: ''},
            {id: 'favicon', val: ''},
            {id: 'language', val: 'en-US'},
        ])
    })

    test('admin (service token) keeps full CRUD', async () => {
        const s = withDriveConfig({})
        const list = await call(s, 'table/drive_config/select?select=id&where=' + encodeURIComponent(`protected`), {}, ADMIN)
        expect(list.status).toEqual(200)
        expect(await list.json()).toEqual([{id: 'secret-0'}, {id: 'secret-1'}])

        const view = await call(s, 'table/drive_config/view/app-name?select=id,val', {}, ADMIN)
        expect(view.status).toEqual(200)
        expect(await view.json()).toEqual({id: 'app-name', val: 'Drive'})

        const ins = await call(s, 'table/drive_config/insert', post({values: {id: 'admin-row', val: 'a'}, returning: ['id', 'val']}), ADMIN)
        expect(ins.status).toEqual(200)
        expect(await ins.json()).toEqual([{id: 'admin-row', val: 'a'}])

        const upd = await call(s, 'table/drive_config/update', post({set: {val: '"b"'}, where: `id = 'admin-row'`, returning: ['val']}), ADMIN)
        expect(upd.status).toEqual(200)
        expect(await upd.json()).toEqual([{val: 'b'}])

        const del = await call(s, 'table/drive_config/delete', post({where: `id = 'admin-row'`, returning: ['id']}), ADMIN)
        expect(del.status).toEqual(200)
        expect(await del.json()).toEqual([{id: 'admin-row'}])
    })

    test('an FK expansion into a rules-less table is rejected for anonymous callers', async () => {
        // files is opened with public: true; its created_by() expansion reaches users, whose rules are stripped
        const open = structuredClone(base)
        const files = open.tables.find(t => t.name === 'files')!
        files.extensions = []
        files.public = true
        const path = 'table/files/select?select=' + encodeURIComponent('id,created_by(username)')

        const withUserRules = await call(open, path)
        expect(withUserRules.status).toEqual(200) // control: users still has its rules here

        const users = open.tables.find(t => t.name === 'users')!
        users.extensions = users.extensions.filter(e => e.name !== 'rules')
        const res = await call(open, path)
        expect(res.status).toEqual(403)
        expect(((await res.json()) as any).message).toEqual('Forbidden')

        const admin = await call(open, path, {}, ADMIN)
        expect(admin.status).toEqual(200)
    })

    test('actions with applyTableRules: false still reach the table', async () => {
        const s = withDriveConfig({})
        s.actions = [{name: 'count_config', applyTableRules: false, steps: {type: 'SELECT', table: 'drive_config'}}]
        const res = await call(s, 'action/count_config', post({}))
        expect(res.status).toEqual(200)
        const rows = ((await res.json()) as any)[0]
        expect(rows.length).toBeGreaterThan(0)
    })

    test('actions with applyTableRules: true are denied like direct CRUD', async () => {
        const s = withDriveConfig({})
        s.actions = [{name: 'count_config_rules', applyTableRules: true, steps: {type: 'SELECT', table: 'drive_config'}}]
        const res = await call(s, 'action/count_config_rules', post({}))
        expect(res.status).toEqual(403)
    })
})

describe('table with public: true (explicit opt-out)', () => {
    test('anonymous callers get the old unrestricted CRUD', async () => {
        const s = withDriveConfig({public: true})

        const list = await call(s, 'table/drive_config/select?select=id&where=' + encodeURIComponent(`protected`))
        expect(list.status).toEqual(200)
        expect(await list.json()).toEqual([{id: 'secret-0'}, {id: 'secret-1'}]) // no listRule filter at all

        const view = await call(s, 'table/drive_config/view/app-name?select=id,val')
        expect(view.status).toEqual(200)
        expect(await view.json()).toEqual({id: 'app-name', val: 'Drive'})

        const ins = await call(s, 'table/drive_config/insert', post({values: {id: 'pub-row', val: 'p'}, returning: ['id']}))
        expect(ins.status).toEqual(200)
        expect(await ins.json()).toEqual([{id: 'pub-row'}])

        const upd = await call(s, 'table/drive_config/update', post({set: {val: '"q"'}, where: `id = 'pub-row'`, returning: ['val']}))
        expect(upd.status).toEqual(200)
        expect(await upd.json()).toEqual([{val: 'q'}])

        const edit = await call(s, 'table/drive_config/edit/pub-row?returning=val', post({val: 'r'}))
        expect(edit.status).toEqual(200)

        const del = await call(s, 'table/drive_config/delete', post({where: `id = 'pub-row'`, returning: ['id']}))
        expect(del.status).toEqual(200)
        expect(await del.json()).toEqual([{id: 'pub-row'}])
    })

    test('signed-in users get the same open access', async () => {
        const res = await call(withDriveConfig({public: true}), 'table/drive_config/select?select=id&limit=1', {}, userToken)
        expect(res.status).toEqual(200)
    })

    test('public: true together with a rules extension is a configuration error', async () => {
        const s = structuredClone(base)
        Object.assign(s.tables.find(t => t.name === 'drive_config')!, {public: true})
        const res = await call(s, 'table/drive_config/select?select=id')
        expect(res.status).toEqual(400)
        const json = await res.json() as any
        expect(json.message).toEqual('Validation Error')
        expect(JSON.stringify(json)).toContain("'public: true' cannot be combined with a rules extension")
    })
})
