import {SELF} from "cloudflare:test";
import {beforeAll, describe, expect, test} from "vitest";
import * as jwt from '@tsndr/cloudflare-worker-jwt';
import {setup} from '../data/drive2/setup'
import {DatabaseSettings} from '../../src'

// The role (auth_audience) column becomes the JWT `aud` claim and `auth.role` in rules, so a non-admin must not be
// able to write it: not at sign-up, not through insert/update/edit, not through an action that runs with the
// user's privileges. Same for email_verified (the `verified` claim) and the password salt. Admin tokens still can.
// The users rules here are the scaffold's (src/node/init.ts): createRule 'true', updateRule 'auth.uid == id' -
// the rules alone let a user write any column of their own row, the framework is what stops it.
// drive2's role column has DEFAULT 'guest'.

const ADMIN = 'test_admin_service_token' // ADMIN_SERVICE_TOKEN in vitest.config.ts
const EXT_ISS = 'https://ext.example.com'
const EXT_SECRET = 'ext-shared-secret-0123456789'

let base: DatabaseSettings
let scaffold: DatabaseSettings

const call = (path: string, init: RequestInit = {}, token?: string, settings: DatabaseSettings = scaffold) => {
    const headers: Record<string, string> = {
        '$DB_TEST_DATABASE_SETTINGS': JSON.stringify(settings),
        'Content-Type': init.method === 'POST' && typeof init.body === 'string' ? 'application/json' : 'text/plain',
        ...init.headers as Record<string, string>,
    }
    if (token) headers['Authorization'] = 'Bearer ' + token
    return SELF.fetch('https://example.com/api/v1/' + path, {...init, headers})
}
const post = (body: any): RequestInit => ({method: 'POST', body: JSON.stringify(body)})
const payload = (token: string) => jwt.decode(token).payload as any

function withChanges(fn: (s: DatabaseSettings) => void) {
    const s = structuredClone(scaffold)
    fn(s)
    return s
}
const usersOf = (s: DatabaseSettings) => s.tables.find(t => t.name === 'users')!
const rulesOf = (s: DatabaseSettings, table: string) => s.tables.find(t => t.name === table)!.extensions.find(e => e.name === 'rules') as any
const fieldOf = (s: DatabaseSettings, table: string, name: string) => s.tables.find(t => t.name === table)!.fields.find(f => f.name === name)!

let n = 0
async function signUp(extra: Record<string, any> = {}, settings = scaffold) {
    const u = 'user' + (++n)
    return call('table/users/auth/sign-up', post({
        username: u, email: `${u}@example.com`, password: '12345678', passwordConfirm: '12345678',
        name: u, meta: '{"base": "/"}', ...extra,
    }), undefined, settings)
}
async function newUser(settings = scaffold) {
    const res = await signUp({}, settings)
    expect(res.status).toEqual(200)
    const json = await res.json() as any
    return {id: json.record.id as string, email: json.record.email as string, token: json.token as string}
}
async function adminView(id: string, select = 'id,role,email,email_verified') {
    const res = await call(`table/users/view/${id}?select=${select}`, {}, ADMIN)
    return res.status === 200 ? await res.json() as any : null
}
const login = async (email: string, settings = scaffold) => {
    const res = await call('table/users/auth/login-password', post({email, password: '12345678'}), undefined, settings)
    expect(res.status).toEqual(200)
    return (await res.json() as any).token as string
}
const expectAdminOnly = async (res: Response, fields: string[]) => {
    expect(res.status).toEqual(403)
    const json = await res.json() as any
    expect(json.message).toEqual(`${fields.join(', ')} can only be set by an admin`)
    for (const f of fields) expect(json.data[f]).toEqual({_errors: [`${f} can only be set by an admin`]})
}

beforeAll(async () => {
    base = await setup() as unknown as DatabaseSettings
    scaffold = structuredClone(base)
    Object.assign(rulesOf(scaffold, 'users'), {
        listRule: 'auth.uid == id', viewRule: 'auth.uid == id',
        createRule: 'true', updateRule: 'auth.uid == id', deleteRule: 'auth.uid == id',
    })
    // the docs' "admin-only table" pattern
    Object.assign(rulesOf(scaffold, 'drive_config'), {
        listRule: "auth.role == 'admin'", viewRule: "auth.role == 'admin'",
        createRule: "auth.role == 'admin'", updateRule: "auth.role == 'admin'", deleteRule: "auth.role == 'admin'",
    })
})

describe('role (auth_audience) is admin-only', () => {
    test('sign-up with role: admin is rejected and creates no user', async () => {
        const res = await signUp({username: 'mallory', email: 'mallory@example.com', role: 'admin'})
        await expectAdminOnly(res, ['role'])
        const check = await call(`table/users/select?select=id&where=${encodeURIComponent(`email = 'mallory@example.com'`)}`, {}, ADMIN)
        expect(await check.json()).toEqual([])
    })

    test('sign-up with role: null is rejected too (any value)', async () => {
        await expectAdminOnly(await signUp({role: null}), ['role'])
    })

    test('sign-up without role gets the column default, and the admin-only table stays closed', async () => {
        const u = await newUser()
        expect(payload(u.token).aud).toEqual(['guest'])
        const res = await call('table/drive_config/list', {}, u.token)
        expect(res.status).toEqual(200)
        expect(((await res.json()) as any).items).toEqual([])
    })

    test('a user cannot promote their own row via /update setValues, /update set or /edit', async () => {
        const u = await newUser()
        await expectAdminOnly(await call('table/users/update', post({
            where: `id == '${u.id}'`, setValues: {role: 'admin'}, returning: ['id', 'role'],
        }), u.token), ['role'])
        await expectAdminOnly(await call('table/users/update', post({
            where: `id == '${u.id}'`, set: {role: "'admin'"}, returning: ['id', 'role'],
        }), u.token), ['role'])
        await expectAdminOnly(await call(`table/users/edit/${u.id}`, post({role: 'admin'}), u.token), ['role'])
        expect((await adminView(u.id)).role).toEqual('guest')
        expect(payload(await login(u.email)).aud).toEqual(['guest'])
    })

    test('unrelated updates of the own row still work', async () => {
        const u = await newUser()
        const res = await call('table/users/update', post({
            where: `id == '${u.id}'`, setValues: {name: 'Renamed'}, returning: ['id', 'name', 'role'],
        }), u.token)
        expect(res.status).toEqual(200)
        expect(await res.json()).toEqual([{id: u.id, name: 'Renamed', role: 'guest'}])
    })

    test('a logged-in user cannot /insert a user row with a role', async () => {
        const u = await newUser()
        await expectAdminOnly(await call('table/users/insert', post({
            values: {username: 'sock', email: 'sock@example.com', password: '12345678', passwordConfirm: '12345678', name: 's', role: 'admin'},
            returning: ['id'],
        }), u.token), ['role'])
    })

    test('a multi-row insert is rejected when any row sets role', async () => {
        await expectAdminOnly(await call('table/users/insert', post({
            values: [
                {username: 'multi1', email: 'multi1@example.com', password: '12345678', passwordConfirm: '12345678', name: 'm', role: 'guest'},
                {username: 'multi2', email: 'multi2@example.com', password: '12345678', passwordConfirm: '12345678', name: 'm', role: 'admin'},
            ],
        })), ['role'])
    })

    test('an action step that runs with the user\'s privileges cannot set role', async () => {
        const u = await newUser()
        const s = withChanges(s => {
            s.actions = [{name: 'set_my_role', requireAuth: true, params: {role: 'string'},
                steps: {type: 'UPDATE', table: 'users', set: {role: 'params.role'}, where: 'id == auth.uid'}} as any]
        })
        await expectAdminOnly(await call('action/set_my_role', post({role: 'admin'}), u.token, s), ['role'])
        expect((await adminView(u.id)).role).toEqual('guest')
    })

    test('an applyTableRules: false action step can set role (the author opted out, like noInsert/noUpdate)', async () => {
        const u = await newUser()
        const s = withChanges(s => {
            s.actions = [{name: 'make_editor', applyTableRules: false, requireAuth: true,
                steps: {type: 'UPDATE', table: 'users', set: {role: "'editor'"}, where: 'id == auth.uid'}} as any]
        })
        const res = await call('action/make_editor', post({}), u.token, s)
        expect(res.status).toEqual(200)
        expect((await adminView(u.id)).role).toEqual('editor')
    })

    test('docs/recipe-full-app.md set_user_role: a user whose role is admin manages roles through a guarded action', async () => {
        // the action exactly as documented (userTable.name -> 'users')
        const s = withChanges(s => {
            s.actions = [{
                name: 'set_user_role', requireAuth: true, applyTableRules: false,
                guard: "auth.role ~ '%admin' & params.role != 'superadmin'",
                params: {user_id: 'string', role: 'string'},
                steps: {type: 'UPDATE', table: 'users', set: {role: 'params.role'},
                    where: "id == params.user_id & role != 'superadmin' & (role !~ '%admin' | auth.role == 'superadmin')"},
            }] as any
        })
        const boss = await newUser(), target = await newUser(), other = await newUser()
        await call('table/users/update', post({where: `id == '${boss.id}'`, setValues: {role: 'admin'}}), ADMIN)
        const bossToken = await login(boss.email)

        const res = await call('action/set_user_role', post({user_id: target.id, role: 'editor'}), bossToken, s)
        expect(res.status).toEqual(200)
        expect((await adminView(target.id)).role).toEqual('editor')
        // a role-admin still can't write role directly: it is not an admin token
        await expectAdminOnly(await call('table/users/update', post({where: `id == '${target.id}'`, setValues: {role: 'admin'}}), bossToken), ['role'])
        // guard: nobody is made superadmin; a guest can't use the action. The guard runs in SQL (LIKE), and a SQL
        // guard denial currently surfaces as 400, not 403: issues/open/action-sql-guard-denial-returns-400.md
        expect((await call('action/set_user_role', post({user_id: target.id, role: 'superadmin'}), bossToken, s)).status).toBeGreaterThanOrEqual(400)
        expect((await call('action/set_user_role', post({user_id: target.id, role: 'admin'}), other.token, s)).status).toBeGreaterThanOrEqual(400)
        expect((await adminView(target.id)).role).toEqual('editor')
    })

    test('the admin service token can promote a user, and the next login carries the role', async () => {
        const u = await newUser()
        const res = await call('table/users/update', post({
            where: `id == '${u.id}'`, setValues: {role: 'admin'}, returning: ['id', 'role'],
        }), ADMIN)
        expect(res.status).toEqual(200)
        expect(await res.json()).toEqual([{id: u.id, role: 'admin'}])
        const token = await login(u.email)
        expect(payload(token).aud).toEqual(['admin'])
        const ins = await call('table/drive_config/insert', post({values: {id: 'promoted', val: 'x'}, returning: ['id']}), token)
        expect(ins.status).toEqual(200)
        expect(await ins.json()).toEqual([{id: 'promoted'}])
    })

    test('the admin service token can insert a user with a role', async () => {
        const res = await call('table/users/insert', post({
            values: {username: 'staff1', email: 'staff1@example.com', password: '12345678', passwordConfirm: '12345678', name: 's', role: 'admin', meta: '{}'},
            returning: ['id', 'role'],
        }), ADMIN)
        expect(res.status).toEqual(200)
        expect(((await res.json()) as any)[0].role).toEqual('admin')
    })

    test('OAuth/token sign-up does not take a role from the external token', async () => {
        const s = {...scaffold, authProviders: [{issuer: EXT_ISS, secret: EXT_SECRET, algorithm: 'HS256'}]} as DatabaseSettings
        const now = Math.floor(Date.now() / 1000)
        const ext = await jwt.sign({iss: EXT_ISS, sub: 'ext1@example.com', email: 'ext1@example.com', email_verified: true,
            role: 'admin', aud: 'admin', iat: now, exp: now + 3600}, EXT_SECRET, {algorithm: 'HS256'})
        const res = await call('table/users/auth/login-token', {method: 'POST', headers: {Authorization: `Bearer ${ext}`}}, undefined, s)
        expect(res.status).toEqual(200)
        const json = await res.json() as any
        expect(payload(json.token).aud).toEqual(['guest'])
        expect((await adminView(json.record.id)).role).toEqual('guest')
    })
})

describe('email_verified and password_salt are admin-only without noInsert/noUpdate in the config', () => {
    // the scaffold marks both noInsert+noUpdate; a hand-written config may not
    const loose = () => withChanges(s => {
        for (const f of ['email_verified', 'password_salt', 'email']) {
            delete (fieldOf(s, 'users', f) as any).noInsert
            delete (fieldOf(s, 'users', f) as any).noUpdate
        }
    })

    test('sign-up with email_verified or password_salt is rejected (email_verified was 400 "must not be set")', async () => {
        await expectAdminOnly(await signUp({email_verified: true}, loose()), ['email_verified'])
        await expectAdminOnly(await signUp({password_salt: 'x'}, loose()), ['password_salt'])
        await expectAdminOnly(await signUp({email_verified: true, role: 'admin'}, loose()), ['role', 'email_verified'])
    })

    test('a user cannot verify their own email or replace their salt via /update', async () => {
        const s = loose()
        const u = await newUser(s)
        await expectAdminOnly(await call('table/users/update', post({
            where: `id == '${u.id}'`, setValues: {email_verified: true},
        }), u.token, s), ['email_verified'])
        await expectAdminOnly(await call('table/users/update', post({
            where: `id == '${u.id}'`, setValues: {password_salt: 'x'},
        }), u.token, s), ['password_salt'])
        expect((await adminView(u.id)).email_verified).toEqual(0)
        await login(u.email, s) // salt unchanged, password still works
    })

    test('changing the email as a user validates it and un-verifies the row; the same address keeps it verified', async () => {
        const s = loose()
        const u = await newUser(s)
        const verify = await call('table/users/update', post({where: `id == '${u.id}'`, setValues: {email_verified: true}}), ADMIN, s)
        expect(verify.status).toEqual(200)

        const bad = await call('table/users/update', post({where: `id == '${u.id}'`, setValues: {email: 'not-an-email'}}), u.token, s)
        expect(bad.status).toEqual(400)

        const same = await call('table/users/update', post({
            where: `id == '${u.id}'`, setValues: {email: u.email.toUpperCase()}, returning: ['email', 'email_verified'],
        }), u.token, s)
        expect(same.status).toEqual(200)
        expect(await same.json()).toEqual([{email: u.email, email_verified: 1}]) // normalized like sign-up, still verified

        const moved = await call('table/users/update', post({
            where: `id == '${u.id}'`, setValues: {email: 'moved-' + u.email}, returning: ['email', 'email_verified'],
        }), u.token, s)
        expect(moved.status).toEqual(200)
        expect(await moved.json()).toEqual([{email: 'moved-' + u.email, email_verified: 0}])
    })

    test('an admin can set email_verified', async () => {
        const s = loose()
        const u = await newUser(s)
        const res = await call('table/users/update', post({
            where: `id == '${u.id}'`, setValues: {email_verified: true}, returning: ['email_verified'],
        }), ADMIN, s)
        expect(res.status).toEqual(200)
        expect(await res.json()).toEqual([{email_verified: 1}])
    })
})
