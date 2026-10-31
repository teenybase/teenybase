import {SELF} from "cloudflare:test";
import {beforeAll, expect, test} from "vitest";
import {setup} from '../data/drive2/setup'
import * as jwt from '@tsndr/cloudflare-worker-jwt';

// change-password asks for the current password unless passwordCurrentSuffix is '' (0.1.1 B2). The schema already
// defaulted the suffix to 'Current' in 0.1.0; these pin that default, the opt-out, and the messages.

const EXT_ISS = 'https://ext-b2.example.com'
const EXT_SECRET = 'ext-b2-shared-secret-0123456789'

let base: any
const withSuffix = (suffix: string | undefined) => {
    const s = structuredClone(base)
    const auth = s.tables.find((t: any) => t.name === 'users').extensions.find((e: any) => e.name === 'auth')
    if (suffix === undefined) delete auth.passwordCurrentSuffix
    else auth.passwordCurrentSuffix = suffix
    s.authProviders = [{issuer: EXT_ISS, secret: EXT_SECRET, algorithm: 'HS256', clientId: 'b2-app'}]
    return s
}
const api = (s: any, path: string, body: any, token?: string) => SELF.fetch('https://localhost/api/v1/table/' + path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {'$DB_TEST_DATABASE_SETTINGS': JSON.stringify(s), 'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {})},
})
/** A user with a verified email (change-password needs auth.email, which unverified sessions don't have). */
async function verifiedUser(s: any, email: string) {
    const now = Math.floor(Date.now() / 1000)
    const tok = await jwt.sign({iss: EXT_ISS, aud: 'b2-app', sub: email, email, email_verified: true, iat: now, exp: now + 600}, EXT_SECRET, {algorithm: 'HS256'})
    const res = await SELF.fetch('https://localhost/api/v1/table/users/auth/login-token', {method: 'POST', headers: {Authorization: 'Bearer ' + tok, '$DB_TEST_DATABASE_SETTINGS': JSON.stringify(s), 'Content-Type': 'text/plain'}})
    expect(res.status).toEqual(200)
    return await res.json() as any
}

beforeAll(async () => { base = await setup() })

test('passwordCurrentSuffix unset: passwordCurrent is required (default Current)', async () => {
    const s = withSuffix(undefined)
    const u = await verifiedUser(s, 'b2-default@example.com')
    const res = await api(s, 'users/auth/change-password', {password: 'new-pass-1234', passwordConfirm: 'new-pass-1234'}, u.token)
    expect(res.status).toEqual(400)
    expect(((await res.json()) as any).message).toEqual('passwordCurrent is required')
})

test('a user created by a sign-in provider gets a message that points at password reset', async () => {
    const s = withSuffix(undefined)
    const u = await verifiedUser(s, 'b2-oauth@example.com')
    const res = await api(s, 'users/auth/change-password', {password: 'new-pass-1234', passwordConfirm: 'new-pass-1234', passwordCurrent: 'some-guess-123'}, u.token)
    expect(res.status).toEqual(400)
    expect(((await res.json()) as any).message).toEqual('Invalid current password. An account created by signing in with a provider has no password of its own: set one with password reset.')
})

test("passwordCurrentSuffix '' turns the check off", async () => {
    const s = withSuffix('')
    const u = await verifiedUser(s, 'b2-off@example.com')
    const res = await api(s, 'users/auth/change-password', {password: 'new-pass-1234', passwordConfirm: 'new-pass-1234'}, u.token)
    expect(res.status).toEqual(200)
    expect((await api(s, 'users/auth/login-password', {email: 'b2-off@example.com', password: 'new-pass-1234'})).status).toEqual(200)
})

test('a record update that sets the password on a table with a salt column points at change-password', async () => {
    const s = withSuffix(undefined)
    const u = await verifiedUser(s, 'b2-edit@example.com')
    const res = await api(s, 'users/edit/' + u.record.id, {password: 'new-pass-1234', passwordConfirm: 'new-pass-1234', passwordCurrent: 'whatever-123'}, u.token)
    expect(res.status).toEqual(400)
    expect(((await res.json()) as any).message).toEqual("To change the password use POST /auth/change-password (a record update can't check passwordCurrent on this table)")
})
