import {SELF} from "cloudflare:test";
import {beforeAll, expect, test} from "vitest";
import {setup} from '../data/drive2/setup'

// End-to-end guards for issues/resolved/error-response-leaks-sql-with-password-hash.md
// The test env sets both RESPOND_WITH_ERRORS and RESPOND_WITH_QUERY_LOG, so these bodies contain the
// most verbose output the server can produce - which is exactly what should still hold no secrets.

let settings: Awaited<ReturnType<typeof setup>>
beforeAll(async () => { settings = await setup() })

const PASSWORD = 'correct-horse-battery'
const SHA256_HEX = /\b[0-9a-f]{64}\b/

const fetch = (input: RequestInfo, init?: RequestInit) => {
    const headers = {'$DB_TEST_DATABASE_SETTINGS': JSON.stringify(settings)} as Record<string, string>
    headers['Content-Type'] = init?.method === 'POST' && typeof init?.body === 'string' ? 'application/json' : 'text/plain'
    return SELF.fetch('https://example.com/api/v1/table/' + input, {...init, headers: {...init?.headers, ...headers}})
}

const signUp = (body: Record<string, any>) => fetch('users/auth/sign-up', {
    method: 'POST',
    body: JSON.stringify({password: PASSWORD, passwordConfirm: PASSWORD, name: 'U',
        role: 'guest', meta: '{"base": "/"}', ...body}),
})

test('a failed sign-up leaks neither the password hash, the salt, nor the plaintext', async () => {
    const first = await signUp({username: 'leak', email: 'leak@example.com'})
    expect(first.status).toEqual(200)

    const dup = await signUp({username: 'leak2', email: 'leak@example.com'})
    expect(dup.status).toEqual(400)
    const body = await dup.text()

    expect(body).not.toMatch(SHA256_HEX)     // no password hash, in data.input or queries[]
    expect(body).not.toContain(PASSWORD)     // no plaintext echo
    // the offending column is still named, as a field error a sign-up form can render; the SQLite
    // message stays in the server log (FieldError.cause), even with the debug flags on
    const json = JSON.parse(body)
    expect(json.message).toEqual('An account with this email already exists')
    expect(json.data).toEqual({email: {_errors: ['An account with this email already exists']}})
})

test('a rejected insert never echoes the submitted plaintext password', () => {
    // $Table.insert throws ProcessError('Error parsing INSERT data', 400, data, e) with the RAW request
    // params, which still hold the CLEARTEXT password (hashing happens later, in onInsertParse). Those
    // params are now scrubbed. NOTE: every route tried here is rejected by zod validation BEFORE
    // parseInsertQuery runs, so that specific throw was not reachable over HTTP in this fixture - the
    // scrub is defence in depth. This test pins the reachable property: a rejected insert body,
    // whatever rejected it, must not contain the password.
    return fetch('users/insert', {
        method: 'POST',
        body: JSON.stringify({values: [{username: 'pf', email: 'pf@example.com', password: PASSWORD}, {}]}),
    }).then(async res => {
        expect(res.status).toBeGreaterThanOrEqual(400)
        expect(await res.text()).not.toContain(PASSWORD)
    })
})

test('a failed authenticated write does not leak the stored hash either', async () => {
    const up = await signUp({username: 'leak3', email: 'leak3@example.com'})
    expect(up.status).toEqual(200)
    const {token} = await up.json() as any

    // violate the update rule / a constraint - whatever the failure, no hash may appear
    const res = await fetch('users/update?where=' + encodeURIComponent(`email='leak@example.com'`), {
        method: 'POST',
        headers: {Authorization: `Bearer ${token}`},
        body: JSON.stringify({set: {email: 'leak3@example.com'}}),
    })
    const body = await res.text()
    expect(body).not.toMatch(SHA256_HEX)
})
