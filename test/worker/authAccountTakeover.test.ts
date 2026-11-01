import {env, fetchMock, SELF} from "cloudflare:test";
import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {setup} from '../data/drive2/setup'
import * as jwt from '@tsndr/cloudflare-worker-jwt';

// Pre-account takeover through email linking (0.1.1 B1). An attacker signs up with a password using the victim's
// email; the victim later signs in with an external provider whose email is verified. Before 0.1.1 the victim landed
// in the attacker's account and the attacker could still sign in with the password and refresh the session.
// Now the verified sign-in takes the account over: email marked verified, password replaced with a random one,
// every existing session ended, identity recorded. Verified rows link as before.

const EXT_ISS = 'https://ext-b1.example.com'
const EXT_SECRET = 'ext-b1-shared-secret-0123456789'
const EXT_AUD = 'b1-app'
const IDP = 'https://idp-b1.example.com'

let base: any
const db = () => (env as any).PRIMARY_DB as D1Database

const withSettings = (mut?: (s: any) => void) => {
    const s = structuredClone(base)
    s.authProviders = [
        {issuer: EXT_ISS, secret: EXT_SECRET, algorithm: 'HS256', clientId: EXT_AUD},
        {name: 'b1prov', clientId: 'cid', clientSecret: 'csecret', scopes: ['email'],
            authorizeUrl: IDP + '/authorize', tokenUrl: IDP + '/token', userinfoUrl: IDP + '/userinfo'},
        {name: 'b1unverified', clientId: 'cid', clientSecret: 'csecret', scopes: ['email'],
            authorizeUrl: IDP + '/authorize', tokenUrl: IDP + '/token', userinfoUrl: IDP + '/userinfo-unverified'},
    ]
    mut?.(s)
    return s
}
const authExt = (s: any) => s.tables.find((t: any) => t.name === 'users').extensions.find((e: any) => e.name === 'auth')
const usersTable = (s: any) => s.tables.find((t: any) => t.name === 'users')

const api = (settings: any) => (path: string, init?: RequestInit) => SELF.fetch('https://localhost/api/v1/table/' + path, {
    redirect: 'manual',
    ...init,
    headers: {
        ...init?.headers,
        '$DB_TEST_DATABASE_SETTINGS': JSON.stringify(settings),
        'Content-Type': init?.method === 'POST' && typeof init?.body === 'string' ? 'application/json' : 'text/plain',
    },
})

const extToken = async (claims: Record<string, any>) => {
    const now = Math.floor(Date.now() / 1000)
    return jwt.sign({iss: EXT_ISS, aud: EXT_AUD, iat: now, exp: now + 3600, ...claims}, EXT_SECRET, {algorithm: 'HS256'})
}
const loginToken = async (settings: any, claims: Record<string, any>) =>
    api(settings)('users/auth/login-token', {method: 'POST', headers: {Authorization: `Bearer ${await extToken(claims)}`}})

const signUp = (settings: any, email: string, username: string, password = 'attacker-pw-1') => api(settings)('users/auth/sign-up', {
    method: 'POST',
    body: JSON.stringify({username, email, password, passwordConfirm: password, name: 'A', meta: '{"base": "/"}'}),
})
const loginPassword = (settings: any, email: string, password: string) => api(settings)('users/auth/login-password', {
    method: 'POST', body: JSON.stringify({email, password}),
})
const refresh = (settings: any, token: string, refresh_token: string) => api(settings)('users/auth/refresh-token', {
    method: 'POST', headers: {Authorization: 'Bearer ' + token}, body: JSON.stringify({refresh_token}),
})
const row = async (email: string) => db().prepare('SELECT id, email_verified, password FROM users WHERE email = ?').bind(email).first<any>()

/** OAuth authorize + callback against the fake IdP. */
async function oauth(settings: any, provider: string) {
    const auth = await api(settings)(`users/auth/oauth/${provider}`)
    expect(auth.status).toEqual(302)
    const state = new URL(auth.headers.get('location')!).searchParams.get('state')!
    const csrf = /oauth_state=([^;]+)/.exec(auth.headers.get('set-cookie') ?? '')![1]
    return api(settings)(`users/auth/oauth/${provider}/callback?code=c0de&state=${encodeURIComponent(state)}`, {headers: {Cookie: `oauth_state=${csrf}`}})
}

beforeAll(async () => {
    base = await setup()
    // the identities table is created by setup-db only when saveIdentities is on in the deployed config; same SQL as InternalIdentities
    await db().prepare('CREATE TABLE IF NOT EXISTS "_auth_identities" (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, provider_id TEXT, identity_data TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, provider))').run()
    fetchMock.activate()
    fetchMock.disableNetConnect()
    const idp = fetchMock.get(IDP)
    idp.intercept({path: '/token', method: 'POST'}).reply(200, JSON.stringify({access_token: 'at'}), {headers: {'content-type': 'application/json'}}).persist()
    idp.intercept({path: '/userinfo', method: 'GET'}).reply(200, JSON.stringify({sub: 'idp-1', email: 'victim-oauth@example.com', email_verified: true, name: 'Victim'}), {headers: {'content-type': 'application/json'}}).persist()
    idp.intercept({path: '/userinfo-unverified', method: 'GET'}).reply(200, JSON.stringify({sub: 'idp-2', email: 'victim-unverified@example.com', email_verified: false, name: 'V'}), {headers: {'content-type': 'application/json'}}).persist()
})
afterAll(() => fetchMock.deactivate())

describe('pre-account takeover (email linking)', () => {
    test('external token: attacker password stops working, attacker sessions end, email becomes verified', async () => {
        const s = withSettings()
        const attacker = await signUp(s, 'victim-token@example.com', 'attacker1')
        expect(attacker.status).toEqual(200)
        const a = await attacker.json() as any
        expect((await row('victim-token@example.com')).email_verified).toEqual(0)

        const victim = await loginToken(s, {sub: 'ext-victim', email: 'victim-token@example.com', email_verified: true})
        expect(victim.status, await victim.clone().text()).toEqual(200)
        const v = await victim.json() as any
        expect(v.record.id).toEqual(a.record.id)
        expect(v.record.email_verified).toEqual(true)
        expect(v.verified).toBeUndefined()

        expect((await row('victim-token@example.com')).email_verified).toEqual(1)
        expect((await loginPassword(s, 'victim-token@example.com', 'attacker-pw-1')).status).toEqual(400)
        const r = await refresh(s, a.token, a.refresh_token)
        expect(r.status).toEqual(401)
        // the victim's own session works
        expect((await refresh(s, v.token, v.refresh_token)).status).toEqual(200)
    })

    test('OAuth callback: same takeover', async () => {
        const s = withSettings()
        const attacker = await signUp(s, 'victim-oauth@example.com', 'attacker2')
        expect(attacker.status).toEqual(200)
        const a = await attacker.json() as any
        const before = await row('victim-oauth@example.com')

        const cb = await oauth(s, 'b1prov')
        expect(cb.status, await cb.clone().text()).toEqual(302)

        const after = await row('victim-oauth@example.com')
        expect(after.id).toEqual(before.id)
        expect(after.email_verified).toEqual(1)
        expect(after.password).not.toEqual(before.password)
        expect((await loginPassword(s, 'victim-oauth@example.com', 'attacker-pw-1')).status).toEqual(400)
        expect((await refresh(s, a.token, a.refresh_token)).status).toEqual(401)
    })

    test('an unverified OAuth email never links to the existing row', async () => {
        const s = withSettings()
        const owner = await signUp(s, 'victim-unverified@example.com', 'owner3', 'owner-pw-123')
        expect(owner.status).toEqual(200)
        const o = await owner.json() as any
        const before = await row('victim-unverified@example.com')

        const cb = await oauth(s, 'b1unverified')
        expect(cb.status).toEqual(400)
        expect(((await cb.json()) as any).message).toEqual('Email not verified')
        expect(await row('victim-unverified@example.com')).toEqual(before)
        expect((await loginPassword(s, 'victim-unverified@example.com', 'owner-pw-123')).status).toEqual(200)
        expect((await refresh(s, o.token, o.refresh_token)).status).toEqual(200)
    })

    test('an unverified external token never links to the existing row', async () => {
        const s = withSettings()
        const owner = await signUp(s, 'tok-unverified@example.com', 'owner4', 'owner-pw-123')
        expect(owner.status).toEqual(200)
        const before = await row('tok-unverified@example.com')
        const res = await loginToken(s, {sub: 'x', email: 'tok-unverified@example.com', email_verified: false})
        expect(res.status).toEqual(400)
        expect(await row('tok-unverified@example.com')).toEqual(before)
        expect((await loginPassword(s, 'tok-unverified@example.com', 'owner-pw-123')).status).toEqual(200)
    })

    test('a verified row links as before: password and sessions keep working', async () => {
        const s = withSettings()
        const up = await signUp(s, 'verified-owner@example.com', 'owner5', 'owner-pw-123')
        expect(up.status).toEqual(200)
        const u = await up.json() as any
        await db().prepare('UPDATE users SET email_verified = 1 WHERE id = ?').bind(u.record.id).run()
        const before = await row('verified-owner@example.com')

        const res = await loginToken(s, {sub: 'y', email: 'verified-owner@example.com', email_verified: true})
        expect(res.status).toEqual(200)
        expect(((await res.json()) as any).record.id).toEqual(u.record.id)
        expect(await row('verified-owner@example.com')).toEqual(before)
        expect((await loginPassword(s, 'verified-owner@example.com', 'owner-pw-123')).status).toEqual(200)
        expect((await refresh(s, u.token, u.refresh_token)).status).toEqual(200)
    })

    test('a verified row with a noSelect email_verified field links as before (not taken over)', async () => {
        const s = withSettings(s => { usersTable(s).fields.find((f: any) => f.name === 'email_verified').noSelect = true })
        const up = await signUp(s, 'hidden-verified@example.com', 'owner7', 'owner-pw-123')
        const u = await up.json() as any
        await db().prepare('UPDATE users SET email_verified = 1 WHERE id = ?').bind(u.record.id).run()
        const before = await row('hidden-verified@example.com')

        expect((await loginToken(s, {sub: 'y', email: 'hidden-verified@example.com', email_verified: true})).status).toEqual(200)
        expect(await row('hidden-verified@example.com')).toEqual(before)
        expect((await loginPassword(s, 'hidden-verified@example.com', 'owner-pw-123')).status).toEqual(200)
    })

    test('a user created by OAuth is email-verified', async () => {
        const s = withSettings()
        const res = await loginToken(s, {sub: 'z', email: 'brand-new@example.com', email_verified: true})
        expect(res.status).toEqual(200)
        const j = await res.json() as any
        expect(j.record.email_verified).toEqual(true)
        expect((await row('brand-new@example.com')).email_verified).toEqual(1)
    })

    test('saveIdentities: the takeover and every later sign-in record the identity', async () => {
        const s = withSettings(x => { authExt(x).saveIdentities = true })
        const attacker = await signUp(s, 'ident@example.com', 'attacker6')
        expect(attacker.status).toEqual(200)
        const id = ((await attacker.json()) as any).record.id
        const res = await loginToken(s, {sub: 'ext-ident', email: 'ident@example.com', email_verified: true})
        expect(res.status).toEqual(200)
        const ids = await db().prepare('SELECT provider, provider_id FROM _auth_identities WHERE user_id = ?').bind(id).all<any>()
        expect(ids.results).toEqual([{provider: EXT_ISS, provider_id: 'ext-ident'}])
    })
})

describe('tables without an email_verified field', () => {
    const noVerified = (x: any) => {
        const users = usersTable(x)
        users.fields = users.fields.map((f: any) => f.name === 'email_verified' ? {...f, usage: undefined} : f)
    }

    test('an existing password row is taken over (its email was never proven)', async () => {
        const s = withSettings(noVerified)
        const attacker = await signUp(s, 'nov-victim@example.com', 'attacker7')
        expect(attacker.status).toEqual(200)
        const a = await attacker.json() as any
        const res = await loginToken(s, {sub: 'nv', email: 'nov-victim@example.com', email_verified: true})
        expect(res.status).toEqual(200)
        expect(((await res.json()) as any).record.id).toEqual(a.record.id)
        expect((await loginPassword(s, 'nov-victim@example.com', 'attacker-pw-1')).status).toEqual(400)
        expect((await refresh(s, a.token, a.refresh_token)).status).toEqual(401)
    })

    test('with saveIdentities but an email users can change, the identity proves nothing: taken over again', async () => {
        // an identity proves the address the row had when it was recorded; without noUpdate on email the owner could
        // have switched the row to someone else's address since then (nothing un-verifies it without email_verified)
        const s = withSettings(x => {
            noVerified(x); authExt(x).saveIdentities = true
            const users = usersTable(x)
            users.fields = users.fields.map((f: any) => f.name === 'email' ? {...f, noUpdate: false} : f)
        })
        const first = await loginToken(s, {sub: 'nv3', email: 'nov-mutable@example.com', email_verified: true})
        expect(first.status).toEqual(200)
        const f = await first.json() as any
        const second = await loginToken(s, {sub: 'nv3', email: 'nov-mutable@example.com', email_verified: true})
        expect(second.status).toEqual(200)
        expect((await refresh(s, f.token, f.refresh_token)).status).toEqual(401)
    })

    test('with saveIdentities, a row an external sign-in already owns links without ending sessions', async () => {
        const s = withSettings(x => { noVerified(x); authExt(x).saveIdentities = true })
        const first = await loginToken(s, {sub: 'nv2', email: 'nov-owner@example.com', email_verified: true})
        expect(first.status).toEqual(200)
        const f = await first.json() as any
        const second = await loginToken(s, {sub: 'nv2', email: 'nov-owner@example.com', email_verified: true})
        expect(second.status).toEqual(200)
        expect((await refresh(s, f.token, f.refresh_token)).status).toEqual(200)
    })
})
