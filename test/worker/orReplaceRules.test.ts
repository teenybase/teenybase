import {SELF} from "cloudflare:test";
import {beforeAll, describe, expect, test} from "vitest";
import {setup} from '../data/drive2/setup'
import {DatabaseSettings} from '../../src'

// issues/resolved/or-replace-bypasses-update-delete-rules.md
// INSERT/UPDATE OR REPLACE deletes the rows it conflicts with (primary key or unique column) without a WHERE,
// so deleteRule/updateRule never run against them. Non-admin callers on a table with rules get 403 unless
// deleteRule is unconditionally true. /edit/:id?or=INSERT is INSERT OR REPLACE, so it's covered too.
// drive2: files rules are `created_by == auth.uid` (+ path), users.deleteRule is admin-only, users.username is unique.

let base: DatabaseSettings
const ADMIN = 'test_admin_service_token' // ADMIN_SERVICE_TOKEN in vitest.config.ts
const users: Record<'victim' | 'attacker', {id: string, token: string}> = {} as any

const call = (path: string, init: RequestInit = {}, token?: string, settings: DatabaseSettings = base) => {
    const headers: Record<string, string> = {
        '$DB_TEST_DATABASE_SETTINGS': JSON.stringify(settings),
        'Content-Type': init.method === 'POST' ? 'application/json' : 'text/plain',
    }
    if (token) headers['Authorization'] = 'Bearer ' + token
    return SELF.fetch('https://example.com/api/v1/' + path, {...init, headers})
}
const post = (body: any): RequestInit => ({method: 'POST', body: JSON.stringify(body)})
const adminFile = async (id: string) => {
    const res = await call(`table/files/view/${id}?select=id,name,created_by`, {}, ADMIN)
    return res.status === 200 ? await res.json() : null
}

beforeAll(async () => {
    base = await setup() as unknown as DatabaseSettings
    for (const name of ['victim', 'attacker'] as const) {
        const res = await call('table/users/auth/sign-up', post({
            username: name, email: `${name}@example.com`, password: '12345678', passwordConfirm: '12345678',
            name, role: 'guest', meta: '{"base": "/"}',
        }))
        expect(res.status).toEqual(200)
        const json = await res.json() as any
        users[name] = {id: json.record.id, token: json.token}
    }
    // storage is isolated per test, so the fixture row is created here
    const res = await call('table/files/insert', post({
        values: {id: 'victim-file', path: '/', name: 'victim', created_by: users.victim.id}, returning: ['id'],
    }), users.victim.token)
    expect(res.status).toEqual(200)
    expect(await res.json()).toEqual([{id: 'victim-file'}])
})

describe('OR REPLACE and table rules', () => {
    test('control: a plain update/delete of the victim file by the attacker matches nothing', async () => {
        const upd = await call('table/files/update', post({where: `id = 'victim-file'`, setValues: {name: 'x'}, returning: ['id']}), users.attacker.token)
        expect(await upd.json()).toEqual([])
        const del = await call('table/files/delete', post({where: `id = 'victim-file'`, returning: ['id']}), users.attacker.token)
        expect(await del.json()).toEqual([])
    })

    test('insert or REPLACE onto another user\'s row is rejected', async () => {
        const res = await call('table/files/insert', post({
            or: 'REPLACE', values: {id: 'victim-file', path: '/', name: 'pwned', created_by: users.attacker.id}, returning: ['*'],
        }), users.attacker.token)
        expect(res.status).toEqual(403)
        expect(((await res.json()) as any).message).toMatch(/^OR REPLACE .* is not allowed on table "files"/)
        expect(await adminFile('victim-file')).toEqual({id: 'victim-file', name: 'victim', created_by: users.victim.id})
    })

    test('edit with or=INSERT onto another user\'s row is rejected', async () => {
        const res = await call('table/files/edit/victim-file?or=INSERT&returning=*', post({
            path: '/', name: 'pwned', created_by: users.attacker.id,
        }), users.attacker.token)
        expect(res.status).toEqual(403)
        expect(await adminFile('victim-file')).toEqual({id: 'victim-file', name: 'victim', created_by: users.victim.id})
    })

    test('update or REPLACE onto another user\'s unique value is rejected', async () => {
        // users.updateRule lets the attacker edit their own row; REPLACE on the unique username would delete the victim
        const res = await call('table/users/update', post({
            or: 'REPLACE', where: `id = '${users.attacker.id}'`, setValues: {username: 'victim'}, returning: ['id', 'username'],
        }), users.attacker.token)
        expect(res.status).toEqual(403)
        const check = await call(`table/users/select?select=id,username&where=${encodeURIComponent(`username = 'victim' | username = 'attacker'`)}&order=username`, {}, ADMIN)
        expect(await check.json()).toEqual([
            {id: users.attacker.id, username: 'attacker'},
            {id: users.victim.id, username: 'victim'},
        ])
    })

    test('the same requests without REPLACE behave normally', async () => {
        const ignore = await call('table/files/insert', post({
            or: 'IGNORE', values: {id: 'victim-file', path: '/', name: 'pwned', created_by: users.attacker.id}, returning: ['id'],
        }), users.attacker.token)
        expect(ignore.status).toEqual(200)
        expect(await ignore.json()).toEqual([])
        expect(await adminFile('victim-file')).toEqual({id: 'victim-file', name: 'victim', created_by: users.victim.id})

        const own = await call('table/files/insert', post({
            values: {id: 'attacker-file', path: '/', name: 'mine', created_by: users.attacker.id}, returning: ['id'],
        }), users.attacker.token)
        expect(own.status).toEqual(200)

        // UPDATE OR <x> is valid SQL now (it used to render as `UPDATE files OR x SET`)
        const updIgnore = await call('table/files/update', post({
            or: 'IGNORE', where: `id = 'attacker-file'`, setValues: {name: 'renamed'}, returning: ['name'],
        }), users.attacker.token)
        expect(updIgnore.status).toEqual(200)
        expect(await updIgnore.json()).toEqual([{name: 'renamed'}])
    })

    test('admin may still use REPLACE', async () => {
        const res = await call('table/files/insert', post({
            or: 'REPLACE', values: {id: 'attacker-file', path: '/', name: 'admin-replaced', created_by: users.victim.id}, returning: ['id', 'name'],
        }), ADMIN)
        expect(res.status).toEqual(200)
        expect(await res.json()).toEqual([{id: 'attacker-file', name: 'admin-replaced'}])

        const edit = await call('table/files/edit/admin-upsert?or=INSERT&returning=id,name', post({path: '/', name: 'upserted'}), ADMIN)
        expect(edit.status).toEqual(200)
        expect(await edit.json()).toEqual({id: 'admin-upsert', name: 'upserted'})
    })

    test('REPLACE is rejected on an auth table even with deleteRule true (auth vetoes non-admin deletes)', async () => {
        const open = structuredClone(base)
        const rules = open.tables.find(t => t.name === 'users')!.extensions.find(e => e.name === 'rules') as any
        rules.deleteRule = 'true'
        // anonymous insert satisfies users.createRule; REPLACE on the victim's email would delete the victim's row
        const res = await call('table/users/insert', post({
            or: 'REPLACE', values: {username: 'taker', email: 'victim@example.com', password: '12345678', passwordConfirm: '12345678',
                name: 'x', role: 'guest', meta: '{"base": "/"}'}, returning: ['id'],
        }), undefined, open)
        expect(res.status).toEqual(403)
        const check = await call(`table/users/select?select=id&where=${encodeURIComponent(`email = 'victim@example.com'`)}`, {}, ADMIN)
        expect(await check.json()).toEqual([{id: users.victim.id}])
    })

    test('REPLACE is rejected with deleteRule true when the table has a trigger on that event', async () => {
        // files has an UPDATE trigger; SQLite would run the trigger body's writes as OR REPLACE too
        const open = structuredClone(base)
        const rules = open.tables.find(t => t.name === 'files')!.extensions.find(e => e.name === 'rules') as any
        rules.deleteRule = 'true'
        const res = await call('table/files/update', post({
            or: 'REPLACE', where: `id = 'victim-file'`, setValues: {name: 'x'}, returning: ['id'],
        }), users.victim.token, open)
        expect(res.status).toEqual(403)
    })

    test('REPLACE is allowed when deleteRule is unconditionally true', async () => {
        const open = structuredClone(base)
        const rules = open.tables.find(t => t.name === 'files')!.extensions.find(e => e.name === 'rules') as any
        rules.deleteRule = 'true'
        const res = await call('table/files/insert', post({
            or: 'REPLACE', values: {id: 'victim-file', path: '/', name: 'open-table', created_by: users.attacker.id}, returning: ['id', 'name'],
        }), users.attacker.token, open)
        expect(res.status).toEqual(200)
        expect(await res.json()).toEqual([{id: 'victim-file', name: 'open-table'}])
    })
})
