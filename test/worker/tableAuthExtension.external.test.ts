import {SELF} from "cloudflare:test";
import {beforeAll, expect, test} from "vitest";
import {setup} from '../data/drive2/setup'
import * as jwt from '@tsndr/cloudflare-worker-jwt';

// External-issuer (OAuth / cross-instance JWT) login. Before this file there was NO test anywhere
// touching /auth/login-token, which is how the auto-created-user path shipped broken twice.
//
// NOTE on what these can and cannot catch: the vitest pool pins workerd 1.20260310.1, which predates
// the 2026-03-19 change that appends " (extended: SQLITE_CONSTRAINT_UNIQUE)" to D1 constraint
// messages. The username-collision test below therefore passes even with the old, broken
// `col.code === 'SQLITE_CONSTRAINT'` check. The production format is pinned in
// test/utils/sqlConstraintError.test.ts, which needs no runtime at all.
// See issues/open/worker-tests-pinned-stale-workerd.md

const EXT_ISS = 'https://ext.example.com'
const EXT_SECRET = 'ext-shared-secret-0123456789'

let settings: any
beforeAll(async () => {
    const s = await setup()
    settings = {...s, authProviders: [{issuer: EXT_ISS, secret: EXT_SECRET, algorithm: 'HS256'}]}
})

const fetch = (input: RequestInfo, init?: RequestInit) => {
    const headers = {'$DB_TEST_DATABASE_SETTINGS': JSON.stringify(settings)} as Record<string, string>
    // same content-type handling as the drive1/drive2 suites: the router requires one even on a
    // body-less POST (login-token carries its credential in the Authorization header)
    headers['Content-Type'] = init?.method === 'POST' && typeof init?.body === 'string' ? 'application/json' : 'text/plain'
    return SELF.fetch('https://example.com/api/v1/table/' + input, {
        ...init, headers: {...init?.headers, ...headers},
    })
}

const extToken = async (email: string, extra: Record<string, any> = {}) => {
    const now = Math.floor(Date.now() / 1000)
    return await jwt.sign({
        iss: EXT_ISS, sub: email, email, email_verified: true,
        iat: now, exp: now + 3600, ...extra,
    }, EXT_SECRET, {algorithm: 'HS256'})
}

const loginToken = async (email: string, extra?: Record<string, any>) =>
    fetch('users/auth/login-token', {
        method: 'POST',
        headers: {Authorization: `Bearer ${await extToken(email, extra)}`},
    })

const signUp = (body: Record<string, any>) => fetch('users/auth/sign-up', {
    method: 'POST',
    body: JSON.stringify({password: '12345678', passwordConfirm: '12345678', name: 'U',
        meta: '{"base": "/"}', ...body}),
})

test('external login creates a user with a username derived from the email', async () => {
    const res = await loginToken('newguy@example.com')
    if (res.status !== 200) console.log(JSON.stringify(await res.json()))
    expect(res.status).toEqual(200)
    const json = await res.json() as any
    expect(json.record.email).toEqual('newguy@example.com')
    expect(json.record.username).toEqual('newguy')
})

test('derived username already taken - retries with a suffix instead of failing', async () => {
    // The regression this guards: the retry was gated on a parsed result code that is malformed in
    // production, so this returned 400 and the frontend showed "Google login failed" (IJ-331).
    const pre = await signUp({username: 'taken', email: 'someone-else@example.com'})
    expect(pre.status).toEqual(200)

    const res = await loginToken('taken@other-domain.com')
    if (res.status !== 200) console.log(JSON.stringify(await res.json()))
    expect(res.status).toEqual(200)
    const json = await res.json() as any
    expect(json.record.email).toEqual('taken@other-domain.com')
    expect(json.record.username).toMatch(/^taken_[a-z0-9]{4}$/)
})

test('existing email logs into the existing account, no duplicate row', async () => {
    const up = await signUp({username: 'existing', email: 'existing@example.com'})
    expect(up.status).toEqual(200)
    const upJson = await up.json() as any

    const res = await loginToken('existing@example.com')
    expect(res.status).toEqual(200)
    const json = await res.json() as any
    expect(json.record.id).toEqual(upJson.record.id)
    expect(json.record.username).toEqual('existing')
})

test('non-Latin email local part gets a deterministic non-empty username', async () => {
    // The ASCII strip empties these out; without a fallback the first such user is written with
    // username='' and every later one collides on it.
    const res = await loginToken('गुजरात@gmail.com')
    if (res.status !== 200) console.log(JSON.stringify(await res.json()))
    expect(res.status).toEqual(200)
    const json = await res.json() as any
    expect(json.record.username).toMatch(/^user_[0-9a-f]{12}$/)

    const res2 = await loginToken('日本語@example.com')
    expect(res2.status).toEqual(200)
    const json2 = await res2.json() as any
    expect(json2.record.username).toMatch(/^user_[0-9a-f]{12}$/)
    expect(json2.record.username).not.toEqual(json.record.username)

    // Deterministic: the same email derives the same base, so a repeat login finds the same row.
    const again = await loginToken('गुजरात@gmail.com')
    expect(again.status).toEqual(200)
    expect(((await again.json()) as any).record.id).toEqual(json.record.id)
})

test('concurrent first logins for one new email converge on a single account', async () => {
    // Pre-taking the derived username widens the findUser -> insert window (every request spends extra
    // INSERT round-trips inside the retry loop), which is what makes the race reachable at all.
    // This assertion is honest about being probabilistic at REACHING the branch: it passes whether or
    // not the race occurs, and fails loudly if it occurs unhandled.
    const pre = await signUp({username: 'racer', email: 'racer-taken@example.com'})
    expect(pre.status).toEqual(200)

    const results = await Promise.all(Array.from({length: 8}, () => loginToken('racer@example.com')))
    const bodies = await Promise.all(results.map(async r => ({status: r.status, json: await r.json() as any})))
    const bad = bodies.filter(b => b.status !== 200)
    if (bad.length) console.log('non-200:', JSON.stringify(bad))
    expect(bad).toEqual([])
    const ids = new Set(bodies.map(b => b.json.record.id))
    expect([...ids]).toHaveLength(1)
})

test('duplicate sign-up returns a readable message for email and for username', async () => {
    // issues/resolved/duplicate-email-error-message.md was closed with a fix that read e.message -
    // always the label 'Failed to run insert query' - so neither branch had ever fired.
    const first = await signUp({username: 'dupe', email: 'dupe@example.com'})
    expect(first.status).toEqual(200)

    const dupEmail = await signUp({username: 'dupe2', email: 'dupe@example.com'})
    expect(dupEmail.status).toEqual(400)
    expect(((await dupEmail.json()) as any).message).toEqual('An account with this email already exists')

    const dupUser = await signUp({username: 'dupe', email: 'dupe-other@example.com'})
    expect(dupUser.status).toEqual(400)
    expect(((await dupUser.json()) as any).message).toEqual('This username is already taken')
})
