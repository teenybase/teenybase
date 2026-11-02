import {env, fetchMock, SELF} from "cloudflare:test";
import {afterAll, beforeAll, beforeEach, describe, expect, test} from "vitest";
import {setup} from '../data/drive2/setup'
import * as jwt from '@tsndr/cloudflare-worker-jwt';

// db.onSignIn (0.1.1 C1). The hook is registered by test/worker/sampleHonoApp.ts when a request carries the
// $DB_TEST_SIGNIN_HOOK header; it writes each event (minus db) to _test_signin_events and, in 'throw' mode, fails.

const EXT_ISS = 'https://ext-c1.example.com'
const EXT_SECRET = 'ext-c1-shared-secret-0123456789'
const EXT_AUD = 'c1-app'
const IDP = 'https://idp-c1.example.com'

let settings: any
const db = () => (env as any).PRIMARY_DB as D1Database

const api = (path: string, init: RequestInit & {hook?: string, s?: any} = {}) => SELF.fetch('https://localhost/api/v1/table/' + path, {
    redirect: 'manual',
    ...init,
    headers: {
        ...init.headers,
        '$DB_TEST_DATABASE_SETTINGS': JSON.stringify(init.s ?? settings),
        ...(init.hook ? {'$DB_TEST_SIGNIN_HOOK': init.hook} : {}),
        'Content-Type': init.method === 'POST' && typeof init.body === 'string' ? 'application/json' : 'text/plain',
    },
})
const post = (path: string, body: any, hook?: string, headers: Record<string, string> = {}) => api(path, {method: 'POST', body: JSON.stringify(body), hook, headers})
const events = async () => ((await db().prepare('SELECT event FROM _test_signin_events ORDER BY rowid').all<any>()).results).map(r => JSON.parse(r.event))
const sessionCount = async (userId: string) => (await db().prepare(`SELECT count(*) AS n FROM "_ddb_internal_kv" WHERE key LIKE ?`).bind(`@session_users${userId}_%`).first<{n: number}>())!.n
const userRow = async (email: string) => db().prepare('SELECT id, role FROM users WHERE email = ?').bind(email).first<any>()

const signUpBody = (email: string, username: string) => ({username, email, password: 'pass-1234', passwordConfirm: 'pass-1234', name: 'N', meta: '{"base": "/"}'})
const extToken = async (claims: Record<string, any>) => {
    const now = Math.floor(Date.now() / 1000)
    return jwt.sign({iss: EXT_ISS, aud: EXT_AUD, iat: now, exp: now + 3600, ...claims}, EXT_SECRET, {algorithm: 'HS256'})
}
async function oauth(hook?: string) {
    const auth = await api('users/auth/oauth/c1prov', {hook})
    expect(auth.status).toEqual(302)
    const state = new URL(auth.headers.get('location')!).searchParams.get('state')!
    const csrf = /oauth_state=([^;]+)/.exec(auth.headers.get('set-cookie') ?? '')![1]
    return api(`users/auth/oauth/c1prov/callback?code=c0de&state=${encodeURIComponent(state)}`, {hook, headers: {Cookie: `oauth_state=${csrf}`}})
}

beforeAll(async () => {
    const s: any = await setup()
    settings = {
        ...s,
        authCookie: {name: 'teeny_auth'},
        email: {mock: true, from: 'test@example.com', variables: {company_name: 'T', company_url: 'https://localhost', company_address: 'a', company_copyright: 'c', support_email: 's@example.com'}},
        authProviders: [
            {issuer: EXT_ISS, secret: EXT_SECRET, algorithm: 'HS256', clientId: EXT_AUD},
            {name: 'c1prov', clientId: 'cid', clientSecret: 'csecret', scopes: ['email'],
                authorizeUrl: IDP + '/authorize', tokenUrl: IDP + '/token', userinfoUrl: IDP + '/userinfo'},
        ],
    }
    await db().prepare('CREATE TABLE IF NOT EXISTS _test_signin_events (event TEXT NOT NULL)').run()
    fetchMock.activate()
    fetchMock.disableNetConnect()
    const idp = fetchMock.get(IDP)
    idp.intercept({path: '/token', method: 'POST'}).reply(200, JSON.stringify({access_token: 'provider-access-token-xyz', refresh_token: 'provider-refresh-token-xyz'}), {headers: {'content-type': 'application/json'}}).persist()
    idp.intercept({path: '/userinfo', method: 'GET'}).reply(200, JSON.stringify({sub: 'gh-42', email: 'oauth-c1@example.com', email_verified: true, name: 'Octo', login: 'octo'}), {headers: {'content-type': 'application/json'}}).persist()
})
afterAll(() => fetchMock.deactivate())
beforeEach(async () => { await db().prepare('DELETE FROM _test_signin_events').run() })

describe('onSignIn is called on every sign-in path with the right arguments', () => {
    test('sign-up, then login-password', async () => {
        const up = await post('users/auth/sign-up', signUpBody('hook-pw@example.com', 'hookpw'), 'record')
        expect(up.status).toEqual(200)
        const u = await up.json() as any
        const login = await post('users/auth/login-password', {email: 'hook-pw@example.com', password: 'pass-1234'}, 'record')
        expect(login.status).toEqual(200)

        const ev = await events()
        expect(ev).toHaveLength(2)
        expect(ev[0]).toEqual({table: 'users', provider: 'password', created: true, sameDb: true,
            user: {...u.record, id: u.record.id}})
        expect(ev[0].user).toMatchObject({id: u.record.id, email: 'hook-pw@example.com', username: 'hookpw'})
        expect(ev[0].user.password).toBeUndefined()
        expect(ev[1]).toMatchObject({table: 'users', provider: 'password', created: false, user: {id: u.record.id}})
        expect(ev[1].external).toBeUndefined()
    })

    test('login-token: provider is the issuer, external is the claims; created only the first time', async () => {
        const tok = await extToken({sub: 'ext-1', email: 'hook-ext@example.com', email_verified: true, name: 'Ext'})
        const first = await api('users/auth/login-token', {method: 'POST', hook: 'record', headers: {Authorization: 'Bearer ' + tok}})
        expect(first.status).toEqual(200)
        const second = await api('users/auth/login-token', {method: 'POST', hook: 'record', headers: {Authorization: 'Bearer ' + tok}})
        expect(second.status).toEqual(200)
        const ev = await events()
        expect(ev.map(e => [e.provider, e.created])).toEqual([[EXT_ISS, true], [EXT_ISS, false]])
        expect(ev[0].external).toMatchObject({iss: EXT_ISS, sub: 'ext-1', email: 'hook-ext@example.com', name: 'Ext'})
        expect(ev[0].user.email).toEqual('hook-ext@example.com')
    })

    test('OAuth callback: provider name, the profile, never the provider tokens', async () => {
        const cb = await oauth('record')
        expect(cb.status, await cb.clone().text()).toEqual(302)
        const ev = await events()
        expect(ev).toHaveLength(1)
        expect(ev[0]).toMatchObject({table: 'users', provider: 'c1prov', created: true, user: {email: 'oauth-c1@example.com'},
            external: {provider: 'c1prov', providerId: 'gh-42', email: 'oauth-c1@example.com', verified: true, rawData: {login: 'octo'}}})
        expect(JSON.stringify(ev[0])).not.toContain('provider-access-token-xyz')
        expect(JSON.stringify(ev[0])).not.toContain('provider-refresh-token-xyz')
    })

    test("confirm-password-reset signs in with provider 'email'", async () => {
        const up = await post('users/auth/sign-up', signUpBody('hook-reset@example.com', 'hookreset'))
        const id = ((await up.json()) as any).record.id
        expect((await post('users/auth/request-password-reset', {email: 'hook-reset@example.com'})).status).toEqual(200)
        const row = await db().prepare(`SELECT key FROM "_ddb_internal_kv" WHERE key LIKE '@token_%' AND value LIKE '%reset_password%' AND value LIKE ?`).bind(`%${id}%`).first<any>()
        const res = await post('users/auth/confirm-password-reset', {token: row.key.replace('@token_', ''), password: 'new-pass-1234', passwordConfirm: 'new-pass-1234'}, 'record')
        expect(res.status).toEqual(200)
        expect((await events()).map(e => [e.provider, e.created, e.user.id])).toEqual([['email', false, id]])
    })

    test('refresh-token does not run the hooks', async () => {
        const up = await post('users/auth/sign-up', signUpBody('hook-refresh@example.com', 'hookrefresh'))
        const u = await up.json() as any
        const res = await api('users/auth/refresh-token', {method: 'POST', hook: 'record', headers: {Authorization: 'Bearer ' + u.token}, body: JSON.stringify({refresh_token: u.refresh_token})})
        expect(res.status).toEqual(200)
        expect(await events()).toEqual([])
    })
})

describe('a hook that throws blocks the sign-in', () => {
    test('login-password: the error is returned and no session is created', async () => {
        const up = await post('users/auth/sign-up', signUpBody('hook-block@example.com', 'hookblock'))
        const id = ((await up.json()) as any).record.id
        const before = await sessionCount(id)
        const res = await post('users/auth/login-password', {email: 'hook-block@example.com', password: 'pass-1234'}, 'throw')
        expect(res.status).toEqual(403)
        const body = await res.json() as any
        expect(body.message).toEqual('Blocked by the sign-in hook')
        expect(body.token).toBeUndefined()
        expect(await sessionCount(id)).toEqual(before)
    })

    test('sign-up: no token, no session; the row stays and the next sign-in has created: false', async () => {
        const res = await post('users/auth/sign-up', signUpBody('hook-block2@example.com', 'hookblock2'), 'throw')
        expect(res.status).toEqual(403)
        const row = await userRow('hook-block2@example.com')
        expect(row).toBeTruthy()
        expect(await sessionCount(row.id)).toEqual(0)
        const login = await post('users/auth/login-password', {email: 'hook-block2@example.com', password: 'pass-1234'}, 'record')
        expect(login.status).toEqual(200)
        expect((await events()).map(e => [e.provider, e.created])).toEqual([['password', true], ['password', false]])
    })

    test('OAuth callback: no auth cookie and no session', async () => {
        const cb = await oauth('throw')
        expect(cb.status).toEqual(403)
        expect(cb.headers.get('set-cookie') ?? '').not.toContain('teeny_auth=')
        const row = await userRow('oauth-c1@example.com')
        expect(await sessionCount(row.id)).toEqual(0)
    })
})

test('changes a hook makes to auth columns are in the new token', async () => {
    const res = await post('users/auth/sign-up', signUpBody('hook-role@example.com', 'hookrole'), 'set-role')
    expect(res.status).toEqual(200)
    const payload = jwt.decode(((await res.json()) as any).token).payload as any
    expect(payload.aud).toEqual(['editor'])
    expect((await userRow('hook-role@example.com')).role).toEqual('editor')
})

test('noSelect auth columns stay out of the response record, with a hook and on login', async () => {
    const s = structuredClone(settings)
    s.tables.find((t: any) => t.name === 'users').fields.find((f: any) => f.name === 'email_verified').noSelect = true
    const up = await api('users/auth/sign-up', {method: 'POST', body: JSON.stringify(signUpBody('hook-hidden@example.com', 'hookhidden')), hook: 'record', s})
    expect(up.status).toEqual(200)
    const u = await up.json() as any
    expect(u.record).not.toHaveProperty('email_verified')
    expect((await events())[0].user).not.toHaveProperty('email_verified')
    const login = await api('users/auth/login-password', {method: 'POST', body: JSON.stringify({email: 'hook-hidden@example.com', password: 'pass-1234'}), s})
    expect(login.status).toEqual(200)
    expect(((await login.json()) as any).record).not.toHaveProperty('email_verified')
})
