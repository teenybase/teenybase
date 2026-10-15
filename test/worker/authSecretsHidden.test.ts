import {SELF} from "cloudflare:test";
import {beforeAll, describe, expect, test} from "vitest";
import * as jwt from '@tsndr/cloudflare-worker-jwt';
import {setup} from '../data/drive2/setup'
import {DatabaseSettings} from '../../src'

// issues/resolved/pocket-viewer-token-reads-hidden-fields.md
// Pocket UI viewer/editor logins are admin tokens (generateAdminToken(role) -> admin: true), and admins used to get
// noSelect columns in every select, so a viewer read every user's password hash and salt through the REST API.
// Now the password hash/salt (auth_password / auth_password_salt usages) are never returned or filterable, for any
// caller; other noSelect columns stay visible to admins.

const ADMIN = 'test_admin_service_token' // ADMIN_SERVICE_TOKEN in vitest.config.ts
const ADMIN_JWT_SECRET = 'test_admin_jwt_secret'
const SECRETS = ['password', 'password_salt']

let base: DatabaseSettings
let viewer: string, editor: string
let user: {id: string, email: string, token: string}

const call = (path: string, init: RequestInit = {}, token?: string, settings: DatabaseSettings = base) => {
    const headers: Record<string, string> = {
        '$DB_TEST_DATABASE_SETTINGS': JSON.stringify(settings),
        'Content-Type': init.method === 'POST' ? 'application/json' : 'text/plain',
    }
    if (token) headers['Authorization'] = 'Bearer ' + token
    return SELF.fetch('https://example.com/api/v1/' + path, {...init, headers})
}
const post = (body: any): RequestInit => ({method: 'POST', body: JSON.stringify(body)})
// users.createRule isn't under test here
const openSignUp = () => {
    const s = structuredClone(base)
    ;(s.tables.find(t => t.name === 'users')!.extensions.find(e => e.name === 'rules') as any).createRule = 'true'
    return s
}
const q = (s: string) => encodeURIComponent(s)

// the token PocketUIExtension's /pocket/login issues (see $Database.generateAdminToken)
const adminToken = (role: string) => {
    const now = Math.floor(Date.now() / 1000)
    return jwt.sign({sub: role + '@localhost', id: 'adm-' + role, meta: {}, aud: role, verified: true, admin: true,
        iat: now, exp: now + 3600, iss: '$db'}, base.jwtSecret + ADMIN_JWT_SECRET, {algorithm: 'HS256'})
}
const expectNoSecrets = (rows: any[]) => {
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) for (const k of SECRETS) expect(r).not.toHaveProperty(k)
}

beforeAll(async () => {
    base = await setup() as unknown as DatabaseSettings
    viewer = await adminToken('viewer')
    editor = await adminToken('editor')
    const res = await call('table/users/auth/sign-up', post({
        username: 'victim', email: 'victim@example.com', password: '12345678', passwordConfirm: '12345678',
        name: 'Victim', meta: '{"base": "/"}',
    }), undefined, openSignUp())
    expect(res.status).toEqual(200)
    const json = await res.json() as any
    user = {id: json.record.id, email: json.record.email, token: json.token}
})

describe.each([
    ['viewer token', () => viewer],
    ['editor token', () => editor],
    ['service token', () => ADMIN],
])('%s', (_name, tok) => {
    test('select=* and list never return the password hash or salt', async () => {
        const sel = await call(`table/users/select?select=*`, {}, tok())
        expect(sel.status).toEqual(200)
        const rows = await sel.json() as any[]
        expectNoSecrets(rows)
        expect(rows.find(r => r.id === user.id)).toMatchObject({username: 'victim', email: 'victim@example.com'})

        const list = await call(`table/users/list`, {}, tok())
        expect(list.status).toEqual(200)
        expectNoSecrets(((await list.json()) as any).items)

        const view = await call(`table/users/view/${user.id}`, {}, tok())
        expect(view.status).toEqual(200)
        expectNoSecrets([await view.json()])
    })

    test('the columns cannot be selected, filtered on or expanded explicitly', async () => {
        for (const path of [
            `table/users/select?select=id,password`,
            `table/users/select?select=id,password_salt`,
            `table/users/select?select=id&where=${q("password_salt ~ '%'")}`,
            `table/users/select?select=id&where=${q("password != ''")}`,
            `table/files/select?select=id,created_by(password)`,
        ]) {
            const res = await call(path, {}, tok())
            expect(res.status, path).toEqual(400)
            expect(await res.text(), path).not.toMatch(/[0-9a-f]{64}/) // no hash echoed in the error
        }
    })
})

describe('writes that return rows', () => {
    test('editor: update with returning=* (the admin UI save) has no secrets, and a password set this way works', async () => {
        const res = await call('table/users/update', post({
            where: `id == '${user.id}'`, setValues: {password: 'changed123', passwordConfirm: 'changed123'}, returning: '*',
        }), editor)
        expect(res.status).toEqual(200)
        const rows = await res.json() as any[]
        expectNoSecrets(rows)
        expect(rows[0].id).toEqual(user.id)
        const login = await call('table/users/auth/login-password', post({email: user.email, password: 'changed123'}))
        expect(login.status).toEqual(200)
    })

    test('editor: insert with returning=* (the admin UI create) has no secrets', async () => {
        const res = await call('table/users/insert', post({
            values: {username: 'made', email: 'made@example.com', password: '12345678', passwordConfirm: '12345678', name: 'm', meta: '{}'},
            returning: '*',
        }), editor)
        expect(res.status).toEqual(200)
        expectNoSecrets(await res.json() as any[])
    })

    test('service token: explicit returning of a secret is rejected', async () => {
        const res = await call('table/users/update', post({where: `id == '${user.id}'`, setValues: {name: 'x'}, returning: ['id', 'password']}), ADMIN)
        expect(res.status).toEqual(400)
    })

    test('service token: an sql-mode action with returning: [*] has no secrets', async () => {
        const s = structuredClone(base)
        s.actions = [{name: 'touch_user', params: {id: 'string'},
            sql: {type: 'UPDATE', table: 'users', set: {name: {q: 'name'}}, where: {q: 'id = {:id}'}, returning: ['*']}}] as any
        const res = await call('action/touch_user', post({id: user.id}), ADMIN, s)
        expect(res.status).toEqual(200)
        const json = await res.json() as any[][]
        expectNoSecrets(json[0])
    })
})

describe('other columns', () => {
    test('a noSelect column that is not a password/salt stays visible to admins only', async () => {
        const s = structuredClone(base)
        s.tables.find(t => t.name === 'users')!.fields.find(f => f.name === 'meta')!.noSelect = true
        const asViewer = await call(`table/users/select?select=*`, {}, viewer, s)
        expect(((await asViewer.json()) as any[]).find(r => r.id === user.id)).toHaveProperty('meta')
        const asUser = await call(`table/users/select?select=*`, {}, user.token, s)
        const own = await asUser.json() as any[]
        expect(own).toHaveLength(1)
        expect(own[0]).not.toHaveProperty('meta')
    })

    test('sign-up and login still work (the auth extension reads the hash itself)', async () => {
        const signUp = await call('table/users/auth/sign-up', post({
            username: 'fresh', email: 'fresh@example.com', password: '12345678', passwordConfirm: '12345678', name: 'f', meta: '{"base": "/"}',
        }), undefined, openSignUp())
        expect(signUp.status).toEqual(200)
        const res = await call('table/users/auth/login-password', post({email: 'fresh@example.com', password: '12345678'}))
        expect(res.status).toEqual(200)
        const json = await res.json() as any
        expect(json.record).not.toHaveProperty('password')
        expect(json.record).not.toHaveProperty('password_salt')
    })
})
