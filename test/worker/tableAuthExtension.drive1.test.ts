import {SELF, env} from "cloudflare:test";
import {beforeAll, expect, test} from "vitest";
import {setup} from '../data/drive1/setup'
import * as jwt from '@tsndr/cloudflare-worker-jwt';
import {TableAuthExtensionData} from '../../src'

let settings: Awaited<ReturnType<typeof setup>>
beforeAll(async () => {
    settings = await setup()
    console.log('Before All - Setup Drive 1')
})

const fetch = (input: RequestInfo, init?: RequestInit)=>SELF.fetch('https://example.com/api/v1/'+input, {...init, ...{
        headers: {
            ...init?.headers,
            '$DB_TEST_DATABASE_SETTINGS': JSON.stringify(settings),
            'Content-Type': init?.method === 'POST' ? 'application/json' : 'text/plain',
        }
    }})

// Settings with mock email enabled (for email verification/password reset tests)
function settingsWithMockEmail() {
    return {
        ...settings,
        email: {
            mock: true,
            from: 'test@example.com',
            variables: {
                company_name: 'Test',
                company_url: 'https://example.com',
                company_address: '123 Test St',
                company_copyright: '2024 Test',
                support_email: 'support@example.com',
            },
        },
    }
}

const fetchWithEmail = (input: RequestInfo, init?: RequestInit)=>SELF.fetch('https://example.com/api/v1/'+input, {...init, ...{
        headers: {
            ...init?.headers,
            '$DB_TEST_DATABASE_SETTINGS': JSON.stringify(settingsWithMockEmail()),
            'Content-Type': init?.method === 'POST' ? 'application/json' : 'text/plain',
        }
    }})

test('without auth should fail', async () => {
    const res = await fetch(`table/users/select?limit=4&select=name,email&where=${encodeURIComponent(`name~'%o%'`)}`)
    expect(res.status).toEqual(200)
    expect((await res.text()).trim()).toEqual(`[]`)
})

test('sign up user fail no confirm', async () => {
    const res = await fetch(`table/users/auth/sign-up`, {
        method: 'POST',
        body: JSON.stringify({
            username: 'admin',
            email: 'admin@example.com',
            password: '12345678',
            name: 'Admin User',
        }),
    })
    const json = await res.json() as any
    expect(res.status).toEqual(400)
    expect(json.data).toEqual({_errors: [], passwordConfirm: { _errors: [ 'passwordConfirm is required' ] }})
    expect(json.message).toEqual('Validation Error')
})

test('sign up user fail confirm mismatch', async () => {
    const res = await fetch(`table/users/auth/sign-up`, {
        method: 'POST',
        body: JSON.stringify({
            username: 'admin',
            email: 'admin@example.com',
            password: '12345678',
            passwordConfirm: 'different',
            name: 'Admin User',
        }),
    })
    const json = await res.json() as any
    expect(res.status).toEqual(400)
    expect(json.data).toEqual({_errors: [], passwordConfirm: { _errors: [ 'password and passwordConfirm do not match' ] }})
    expect(json.message).toEqual('Validation Error')
})

async function createUser(data: any, status = 200) {
    const res = await fetch(`table/users/auth/sign-up`, {
        method: 'POST',
        body: JSON.stringify({
            username: 'admin',
            email: 'admin@example.com',
            password: '12345678',
            passwordConfirm: '12345678',
            name: 'Admin User',
            ...data,
        }),
    })
    expect(res.status).toEqual(status)
    return await res.json() as any
}

test('sign up with password no name', async () => {
    const uid = "O-iV9qZXTMOp1U2VV5XC9Q"
    const json = await createUser({name: undefined, id: uid}, 400)
    // uncomment this when the test fails later
    // expect(json.code).toEqual(400)
    // expect(json.message).toEqual('Validation Error')
    // expect(json.data?.name?._errors?.[0]).toMatch(/expected string/)

    // console.log(json)
    delete json.queries;
    // The password hash used to be inlined here verbatim - this assertion is what pinned the leak in
    // place. Secret literals now render as '***' (they are still bound normally and reach SQLite
    // unchanged). See issues/resolved/error-response-leaks-sql-with-password-hash.md
    expect(json).toEqual({
        code: 400,
        message: 'Failed to run insert query',
        data: {
            error: 'NOT NULL constraint failed: users.name: SQLITE_CONSTRAINT',
            // role is left out (admin-only), so the createRule `role = 'guest'` reads its column default from [new]
            input: `WITH [new] ([username], [email], [password], [id], [email_verified], [name], [created], [role], [meta], [avatar]) AS (SELECT "admin", "admin@example.com", '***', "O-iV9qZXTMOp1U2VV5XC9Q", 0, NULL, (CURRENT_TIMESTAMP), "guest", "{}", NULL) INSERT INTO [users] ([username], [email], [password], [id], [email_verified]) SELECT [username], [email], [password], [id], [email_verified] FROM [new] WHERE (([new].[role]) = "guest") RETURNING [users].[id], [users].[username], [users].[email], [users].[email_verified], [users].[role], [users].[meta];`,
            name: {
                code: 'SQLITE_CONSTRAINT',
                constraint: "NOT NULL",
                errorMessage: "NOT NULL constraint failed: users.name: SQLITE_CONSTRAINT",
                message: 'This field cannot be NULL.'
            }
        }
    })
})

test('sign up with password', async () => {
    const json = await createUser({})
    expect(json.verified).toEqual(false)
    const authExt = settings.tables.find(t=>t.name==='users')?.extensions.find(e=>e.name==='auth') as TableAuthExtensionData
    expect(authExt).toBeDefined()
    await jwt.verify(json.token, settings.jwtSecret + authExt.jwtSecret, {throwError: true})
    const decode = jwt.decode(json.token).payload!
    // console.log(decode)
    expect(decode.aud).toEqual(['guest'])
    expect((decode as any).verified).toEqual(false)
    expect((decode as any).cid).toEqual('users')
    expect(decode.sub).toEqual('admin@example.com')
})

test('sign up with password - fail', async () => {
    const res = await createUser({password: '123'}, 400)
    expect(res.message).toEqual('Validation Error')
    expect(res.data).toEqual({_errors: [], password: { _errors: [ 'Password must be at least 8 characters long' ] }})
})

test('login with pass - wrong pass', async () => {
    await createUser({username: 'a'})

    const res = await fetch(`table/users/auth/login-password`, {
        method: 'POST',
        body: JSON.stringify({
            username: 'a', password: 'aaaaaaaa',
        }),
    })
    expect(res.status).toEqual(400)
    expect((await res.json() as any).message).toEqual('Invalid username or password')
})

test('login with pass and token refresh', async () => {
    await createUser({username: 'a'})

    const res = await fetch(`table/users/auth/login-password`, {
        method: 'POST',
        body: JSON.stringify({username: 'a', password: '12345678',}),
    })
    expect(res.status).toEqual(200)
    const json = await res.json() as any

    const authExt = settings.tables.find(t=>t.name==='users')?.extensions.find(e=>e.name==='auth') as TableAuthExtensionData
    expect(authExt).toBeDefined()
    const token = json.token
    expect(token).toBeDefined()
    await jwt.verify(token, settings.jwtSecret + authExt.jwtSecret, {throwError: true})
    const decode = jwt.decode(token).payload!
    // console.log(decode)
    expect(decode.aud).toEqual(['guest'])
    expect((decode as any).verified).toEqual(false)
    expect((decode as any).cid).toEqual('users')
    expect(decode.sub).toEqual('admin@example.com')
    expect(json.record.email).toEqual('admin@example.com')
    expect(json.record.password).toBeUndefined()
    expect(json.record.username).toEqual('a')
    expect(json.record.email_verified).toEqual(false)
    const refresh_token = json.refresh_token
    expect(refresh_token).toBeDefined()

    await new Promise(r=>setTimeout(r, 1100)) // wait for 1.1 sec to ensure new token has different iat

    const res2 = await fetch(`table/users/auth/refresh-token`, {
        method: 'POST',
        headers: {'Authorization': 'Bearer ' + token,},
        body: JSON.stringify({refresh_token}),
    })
    expect(res2.status).toEqual(200)
    const json2 = await res2.json() as any
    expect(token).not.toEqual(json2.token)
    await jwt.verify(json2.token, settings.jwtSecret + authExt.jwtSecret, {throwError: true})
    const decode2 = jwt.decode(json2.token).payload!
    // console.log(decode2)
    // expect((decode2 as any).rc).toEqual(1)
    expect((decode2 as any).cid).toEqual('users')
    expect(decode2.sub).toEqual('admin@example.com')
})

test('login with email, pass', async () => {
    await createUser({username: 'testuser', email: 'adm.in+3.hello123@gmail.com'})

    const res = await fetch(`table/users/auth/login-password`, {
        method: 'POST',
        body: JSON.stringify({email: 'ADMI.N+23@gmaIL.cOm', password: '12345678',}),
    })
    expect(res.status).toEqual(200)
    const json = await res.json() as any
    const authExt = settings.tables.find(t=>t.name==='users')?.extensions.find(e=>e.name==='auth') as TableAuthExtensionData
    expect(authExt).toBeDefined()
    await jwt.verify(json.token, settings.jwtSecret + authExt.jwtSecret, {throwError: true})
    const decode = jwt.decode(json.token).payload!
    expect(decode.aud).toEqual(['guest'])
    expect((decode as any).verified).toEqual(false)
    expect((decode as any).cid).toEqual('users')
    expect(decode.sub).toEqual('admin@gmail.com')
    expect((decode as any).user).toEqual('testuser')

})

test('list users - *', async () => {
    const token = await createUser({username: 'a'})

    const res = await fetch(`table/users/select`, {
        method: 'GET',
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    expect(res.status).toEqual(200)
    const json = await res.json()
    for (const jsonElement of json as any[]) {
        delete jsonElement.id
        delete jsonElement.created
        // password should not be in the json since noSelect is true
    }
    // console.log(JSON.stringify(json))
    expect(JSON.stringify(json)).toEqual('[{"name":"Admin User","email":"admin@example.com","email_verified":0,"username":"a","role":"guest","meta":"{}","avatar":null}]')
    // console.log(z.coerce.boolean().parse(undefined))
})
test('list users', async () => {
    const token = await createUser({username: 'a'})
    const res = await fetch(`table/users/select?select=name,username,email`, {
        method: 'GET',
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    expect(res.status).toEqual(200)
    expect(await res.text()).toEqual('[{"name":"Admin User","username":"a","email":"admin@example.com"}]')
})

test('action mark verified', async () => {
    let json = await createUser({})
    let json3 = await createUser({username: 'admin2', email: 'admin2@example.com'})
    expect(json.verified).toEqual(false)
    // console.log(json)
    const res1 = await fetch(`action/mark_verified`, {
        method: 'POST',
        body: JSON.stringify({
            email: 'admin@example.com',
            id: json.record.id,
        }),
        headers: {'Authorization': 'Bearer ' + json.token,},
    })
    expect(res1.status).toEqual(200)
    const res1json = (await res1.json() as any)[0][0]
    // todo this should be `true`
    expect(res1json.email_verified).toEqual(1)
    // password should NOT be returned when returning: ['*'] is used (noSelect field filtering)
    expect(res1json.password).toBeUndefined()

    const res2 = await fetch(`table/users/auth/login-password`, {
        method: 'POST',
        body: JSON.stringify({ email: 'admin@example.com', password: '12345678',}),
    })
    expect(res2.status).toEqual(200)
    const res2json = await res2.json() as any
    console.log(res2json)
    expect(res2json.token).toBeDefined()
    expect(res2json.record.email_verified).toEqual(true)
    expect(res2json.record.password).toBeUndefined()


    const res3 = await fetch(`table/users/auth/login-password`, {
        method: 'POST',
        body: JSON.stringify({ email: 'admin2@example.com', password: '12345678',}),
    })
    expect(res3.status).toEqual(200)
    const res3json = await res3.json() as any
    expect(res3json.record.email_verified).toEqual(false)
    expect(res3json.record.password).toBeUndefined()

})

test('change password', async () => {
    let json = await createUser({})
    expect(json.verified).toEqual(false)
    // console.log(json)
    const res1 = await fetch(`action/mark_verified`, {
        method: 'POST',
        body: JSON.stringify({
            email: 'admin@example.com',
            id: json.record.id,
        }),
        headers: {'Authorization': 'Bearer ' + json.token,},
    })
    expect(res1.status).toEqual(200)

    const res2 = await fetch(`table/users/auth/login-password`, {
        method: 'POST',
        body: JSON.stringify({ email: 'admin@example.com', password: '12345678',}),
    })
    expect(res2.status).toEqual(200)
    const res2json = await res2.json() as any

    let res = await fetch(`table/users/auth/change-password`, {
        method: 'POST',
        body: JSON.stringify({
            email: 'admin@example.com',
            password: '1234567899',
            passwordConfirm: '1234567899',
            passwordCurrent: '',
        }),
        headers: {'Authorization': 'Bearer ' + res2json.token,},
    })
    expect(res.status).toEqual(400)
    json = await res.json()
    expect(json.message).toEqual('passwordCurrent is required')

    res = await fetch(`table/users/auth/change-password`, {
        method: 'POST',
        body: JSON.stringify({
            email: 'admin@example.com',
            password: '1234567899',
            passwordCurrent: '12345678',
        }),
        headers: {'Authorization': 'Bearer ' + res2json.token,},
    })
    expect(res.status).toEqual(400)
    json = await res.json()
    expect(json.message).toEqual('Validation Error')
    expect(json.data).toEqual({_errors: [], passwordConfirm: { _errors: [ 'passwordConfirm is required' ] }})

    res = await fetch(`table/users/auth/change-password`, {
        method: 'POST',
        body: JSON.stringify({
            email: 'admin@example.com',
            password: '1234567899',
            passwordConfirm: '1234567899',
            passwordCurrent: '12345678',
        }),
        headers: {'Authorization': 'Bearer ' + res2json.token,},
    })
    expect(res.status).toEqual(200)
    res = await fetch(`table/users/auth/login-password`, {
        method: 'POST',
        body: JSON.stringify({ email: 'admin@example.com', password: '1234567899',}),
    })
    expect(res.status).toEqual(200)
})

// issues/resolved/auth-change-password-mass-assignment.md: change-password writes with rawUpdate (no rules),
// so it must only write the password. users.updateRule is null here: a user can't update their row at all.
test('change password ignores every non-password field in the body', async () => {
    const json = await createUser({})
    const res1 = await fetch(`action/mark_verified`, {
        method: 'POST',
        body: JSON.stringify({email: 'admin@example.com', id: json.record.id}),
        headers: {'Authorization': 'Bearer ' + json.token},
    })
    expect(res1.status).toEqual(200)
    const res2 = await fetch(`table/users/auth/login-password`, {
        method: 'POST',
        body: JSON.stringify({email: 'admin@example.com', password: '12345678'}),
    })
    expect(res2.status).toEqual(200)
    const token = (await res2.json() as any).token

    const res = await fetch(`table/users/auth/change-password`, {
        method: 'POST',
        body: JSON.stringify({
            password: '1234567899',
            passwordConfirm: '1234567899',
            passwordCurrent: '12345678',
            role: 'admin',
            email: 'attacker@example.com',
            email_verified: false,
            username: 'pwned',
            name: 'Pwned',
            meta: {pwned: true},
        }),
        headers: {'Authorization': 'Bearer ' + token},
    })
    expect(res.status).toEqual(200)
    expect(await res.json()).toEqual({success: true})

    // the password changed...
    const res3 = await fetch(`table/users/auth/login-password`, {
        method: 'POST',
        body: JSON.stringify({email: 'admin@example.com', password: '1234567899'}),
    })
    expect(res3.status).toEqual(200)
    const json3 = await res3.json() as any
    // ...and nothing else did
    const payload = jwt.decode(json3.token).payload as any
    expect(payload.aud).toEqual(['guest'])
    expect(payload.sub).toEqual('admin@example.com')
    expect(payload.verified).toEqual(true)
    const res5 = await fetch(`table/users/select?select=username,email,email_verified,name,role,meta`, {
        headers: {'Authorization': 'Bearer ' + json3.token},
    })
    expect(res5.status).toEqual(200)
    expect(await res5.json()).toEqual([{
        username: 'admin', email: 'admin@example.com', email_verified: 1, name: 'Admin User', role: 'guest', meta: '{}',
    }])

    const res4 = await fetch(`table/users/auth/login-password`, {
        method: 'POST',
        body: JSON.stringify({email: 'attacker@example.com', password: '1234567899'}),
    })
    expect(res4.status).toEqual(400)
})

test('logout - invalidate session', async () => {
    // Create user and login
    const json = await createUser({username: 'logouttest', email: 'logout@example.com'})
    expect(json.verified).toEqual(false)
    expect(json.token).toBeDefined()
    expect(json.refresh_token).toBeDefined()

    const token = json.token
    const refresh_token = json.refresh_token

    // Verify token works before logout
    const res1 = await fetch(`table/users/select?select=name,username,email`, {
        method: 'GET',
        headers: {'Authorization': 'Bearer ' + token},
    })
    expect(res1.status).toEqual(200)
    const users = await res1.json() as any[]
    expect(users.length).toBeGreaterThan(0)

    // Wait a bit to ensure different iat
    await new Promise(r=>setTimeout(r, 100))

    // Verify refresh token works before logout
    const res2 = await fetch(`table/users/auth/refresh-token`, {
        method: 'POST',
        headers: {'Authorization': 'Bearer ' + token},
        body: JSON.stringify({refresh_token}),
    })
    expect(res2.status).toEqual(200)
    const json2 = await res2.json() as any
    expect(json2.token).toBeDefined()
    expect(json2.refresh_token).toBeDefined()

    // Logout
    const res3 = await fetch(`table/users/auth/logout`, {
        method: 'POST',
        headers: {'Authorization': 'Bearer ' + token},
    })
    expect(res3.status).toEqual(200)
    const logoutJson = await res3.json() as any
    expect(logoutJson.success).toEqual(true)

    // Try to refresh token after logout - should fail
    const res4 = await fetch(`table/users/auth/refresh-token`, {
        method: 'POST',
        headers: {'Authorization': 'Bearer ' + token},
        body: JSON.stringify({refresh_token}),
    })
    expect(res4.status).toEqual(401)
    const json4 = await res4.json() as any
    expect(json4.message).toEqual('Invalid session')

    // Old token should still work for regular API calls until it expires
    // (JWT tokens are stateless, logout only invalidates the refresh token/session)
    const res5 = await fetch(`table/users/select?select=name,username,email`, {
        method: 'GET',
        headers: {'Authorization': 'Bearer ' + token},
    })
    expect(res5.status).toEqual(200)
})

test('logout - without auth fails', async () => {
    // Try to logout without authentication
    const res = await fetch(`table/users/auth/logout`, {
        method: 'POST',
    })
    expect(res.status).toEqual(401)
    const json = await res.json() as any
    expect(json.message).toEqual('Unauthorized')
})

// --- Email Verification Tests ---

// Helper to insert a token directly into the KV table (bypasses email sending)
async function insertKvToken(token: string, data: {id: string, sub: string, typ: string, cid: string}, expiryOffsetSeconds = 3600) {
    const key = '@token_' + token
    const value = JSON.stringify(data)
    const expiry = Math.floor(Date.now() / 1000) + expiryOffsetSeconds
    await env.PRIMARY_DB.prepare(
        `INSERT OR REPLACE INTO "_ddb_internal_kv" (key, value, expiry) VALUES (?, ?, ?)`
    ).bind(key, value, expiry).run()
}

// Generate a 22-char token matching uidTokenSchema (same format as generateUid)
function testToken(suffix: string) {
    // Pad/truncate to exactly 22 chars
    return ('T' + suffix + 'AAAAAAAAAAAAAAAAAAAAA').substring(0, 22)
}

// --- Email Verification Tests ---

test('request-verification fails without email config', async () => {
    const json = await createUser({})
    // The test drive1 config has no email configured: 501 (server capability missing), not a 500 crash
    const res = await fetch(`table/users/auth/request-verification`, {
        method: 'POST',
        headers: {'Authorization': 'Bearer ' + json.token},
    })
    expect(res.status).toEqual(501)
    const body = await res.json() as any
    expect(body.message).toMatch(/^Email not configured: add an `email` provider/)
})

test('request-verification fails without auth', async () => {
    const res = await fetchWithEmail(`table/users/auth/request-verification`, {
        method: 'POST',
    })
    expect(res.status).toEqual(403)
    const body = await res.json() as any
    expect(body.message).toEqual('Unauthorized')
})

test('request-verification → confirm-verification (full flow with mock email)', async () => {
    const json = await createUser({})
    const userId = json.record.id
    const userEmail = 'admin@example.com'

    // Request verification with mock email config — token gets stored in KV, email is "sent" via mock
    const reqRes = await fetchWithEmail(`table/users/auth/request-verification`, {
        method: 'POST',
        headers: {'Authorization': 'Bearer ' + json.token},
    })
    expect(reqRes.status).toEqual(200)
    const reqBody = await reqRes.json() as any
    expect(reqBody.success).toEqual(true)

    // Verify mock email was "sent" with correct content via X-Mock-Email header
    const mockEmail = JSON.parse(reqRes.headers.get('X-Mock-Email')!)
    expect(mockEmail.to).toEqual(userEmail)
    expect(mockEmail.subject).toContain('Verify')
    expect(mockEmail.html).toContain('verify') // action link contains verify path
    // Plain-text body is rendered alongside html
    expect(mockEmail.text).toBeTruthy()
    expect(mockEmail.text).not.toBe(mockEmail.html)
    expect(mockEmail.text).toContain('Verify Email')
    expect(mockEmail.text).toContain('/verify-email/')

    // Find the token in KV — it was stored as @token_<TOKEN> with typ=verify_email
    const kvRows = await env.PRIMARY_DB.prepare(
        `SELECT key, value FROM "_ddb_internal_kv" WHERE key LIKE '@token_%' AND value LIKE '%verify_email%' AND value LIKE '%${userId}%'`
    ).all()
    expect(kvRows.results.length).toBeGreaterThanOrEqual(1)
    const kvRow = kvRows.results[kvRows.results.length - 1] as any
    const token = kvRow.key.replace('@token_', '')
    const tokenData = JSON.parse(kvRow.value)
    expect(tokenData.typ).toEqual('verify_email')
    expect(tokenData.sub).toEqual(userEmail)
    expect(tokenData.cid).toEqual('users')

    // Confirm verification using the token from KV
    const confirmRes = await fetch(`table/users/auth/confirm-verification`, {
        method: 'POST',
        body: JSON.stringify({token}),
    })
    expect(confirmRes.status).toEqual(200)
    const confirmBody = await confirmRes.json() as any
    expect(confirmBody.record).toBeDefined()
    expect(confirmBody.record.email_verified).toEqual(true)
    // Should return a new session since we're not authenticated in this request
    expect(confirmBody.token).toBeDefined()
    expect(confirmBody.refresh_token).toBeDefined()

    // Verify that login now shows email_verified = true
    const loginRes = await fetch(`table/users/auth/login-password`, {
        method: 'POST',
        body: JSON.stringify({email: userEmail, password: '12345678'}),
    })
    expect(loginRes.status).toEqual(200)
    const loginJson = await loginRes.json() as any
    expect(loginJson.record.email_verified).toEqual(true)
})

test('request-verification throttles repeated requests', async () => {
    const json = await createUser({})

    // First request should succeed
    const res1 = await fetchWithEmail(`table/users/auth/request-verification`, {
        method: 'POST',
        headers: {'Authorization': 'Bearer ' + json.token},
    })
    expect(res1.status).toEqual(200)

    // Second request within 2 minutes should be throttled
    const res2 = await fetchWithEmail(`table/users/auth/request-verification`, {
        method: 'POST',
        headers: {'Authorization': 'Bearer ' + json.token},
    })
    expect(res2.status).toEqual(400)
    const body2 = await res2.json() as any
    expect(body2.message).toEqual('Verification email already sent')
})

test('confirm-verification with invalid token', async () => {
    const tok = testToken('invalid1')
    const res = await fetch(`table/users/auth/confirm-verification`, {
        method: 'POST',
        body: JSON.stringify({token: tok}),
    })
    expect(res.status).toEqual(400)
    const body = await res.json() as any
    expect(body.message).toEqual('Invalid token')
})

test('confirm-verification with expired token', async () => {
    const json = await createUser({})
    const tok = testToken('expveri1')
    // Insert with negative expiry (already expired)
    await insertKvToken(tok, {
        id: json.record.id,
        sub: 'admin@example.com',
        typ: 'verify_email',
        cid: 'users',
    }, -10) // expired 10 seconds ago

    const res = await fetch(`table/users/auth/confirm-verification`, {
        method: 'POST',
        body: JSON.stringify({token: tok}),
    })
    expect(res.status).toEqual(400)
    const body = await res.json() as any
    expect(body.message).toEqual('Invalid token')
})

test('confirm-verification with wrong type token', async () => {
    const json = await createUser({})
    const tok = testToken('wrongty1')
    // Insert a reset_password token, but try to use it for verification
    await insertKvToken(tok, {
        id: json.record.id,
        sub: 'admin@example.com',
        typ: 'reset_password',
        cid: 'users',
    })

    const res = await fetch(`table/users/auth/confirm-verification`, {
        method: 'POST',
        body: JSON.stringify({token: tok}),
    })
    expect(res.status).toEqual(400)
    const body = await res.json() as any
    expect(body.message).toEqual('Invalid token type')
})

test('confirm-verification token is consumed (single use)', async () => {
    const json = await createUser({})
    const tok = testToken('singlev1')
    await insertKvToken(tok, {
        id: json.record.id,
        sub: 'admin@example.com',
        typ: 'verify_email',
        cid: 'users',
    })

    // First use should succeed
    const res1 = await fetch(`table/users/auth/confirm-verification`, {
        method: 'POST',
        body: JSON.stringify({token: tok}),
    })
    expect(res1.status).toEqual(200)

    // Second use should fail (token consumed by pop)
    const res2 = await fetch(`table/users/auth/confirm-verification`, {
        method: 'POST',
        body: JSON.stringify({token: tok}),
    })
    expect(res2.status).toEqual(400)
    const body2 = await res2.json() as any
    expect(body2.message).toEqual('Invalid token')
})

// --- Password Reset Tests ---

test('request-password-reset fails without email config', async () => {
    await createUser({})
    // drive1 config has no email configured
    const res = await fetch(`table/users/auth/request-password-reset`, {
        method: 'POST',
        body: JSON.stringify({email: 'admin@example.com'}),
    })
    expect(res.status).toEqual(501)
    const body = await res.json() as any
    expect(body.message).toMatch(/^Email not configured: add an `email` provider/)
    // same answer for an address with no account
    const res2 = await fetch(`table/users/auth/request-password-reset`, {
        method: 'POST',
        body: JSON.stringify({email: 'nobody@example.com'}),
    })
    expect(res2.status).toEqual(501)
})

test('request-password-reset → confirm-password-reset (full flow with mock email)', async () => {
    const json = await createUser({})
    const userId = json.record.id
    const userEmail = 'admin@example.com'

    // Request password reset with mock email config
    const reqRes = await fetchWithEmail(`table/users/auth/request-password-reset`, {
        method: 'POST',
        body: JSON.stringify({email: userEmail}),
    })
    expect(reqRes.status).toEqual(200)
    const reqBody = await reqRes.json() as any
    expect(reqBody.success).toEqual(true)

    // Verify mock email was "sent" with correct content via X-Mock-Email header
    const mockEmail = JSON.parse(reqRes.headers.get('X-Mock-Email')!)
    expect(mockEmail.to).toEqual(userEmail)
    expect(mockEmail.subject).toContain('Reset')
    expect(mockEmail.html).toContain('reset') // action link contains reset path
    // Plain-text body is rendered alongside html
    expect(mockEmail.text).toBeTruthy()
    expect(mockEmail.text).not.toBe(mockEmail.html)
    expect(mockEmail.text).toContain('Reset Password')
    expect(mockEmail.text).toContain('/reset-password/')

    // Find the token in KV
    const kvRows = await env.PRIMARY_DB.prepare(
        `SELECT key, value FROM "_ddb_internal_kv" WHERE key LIKE '@token_%' AND value LIKE '%reset_password%' AND value LIKE '%${userId}%'`
    ).all()
    expect(kvRows.results.length).toBeGreaterThanOrEqual(1)
    const kvRow = kvRows.results[kvRows.results.length - 1] as any
    const token = kvRow.key.replace('@token_', '')
    const tokenData = JSON.parse(kvRow.value)
    expect(tokenData.typ).toEqual('reset_password')
    expect(tokenData.sub).toEqual(userEmail)

    // Confirm password reset using the token from KV
    const newPassword = 'newpassword123'
    const confirmRes = await fetch(`table/users/auth/confirm-password-reset`, {
        method: 'POST',
        body: JSON.stringify({
            token,
            password: newPassword,
            passwordConfirm: newPassword,
        }),
    })
    expect(confirmRes.status).toEqual(200)
    const confirmBody = await confirmRes.json() as any
    expect(confirmBody.token).toBeDefined()
    expect(confirmBody.refresh_token).toBeDefined()
    expect(confirmBody.record).toBeDefined()
    // Password reset also marks email as verified
    expect(confirmBody.record.email_verified).toEqual(true)

    // Login with new password should succeed
    const loginRes = await fetch(`table/users/auth/login-password`, {
        method: 'POST',
        body: JSON.stringify({email: userEmail, password: newPassword}),
    })
    expect(loginRes.status).toEqual(200)

    // Login with old password should fail
    const oldLoginRes = await fetch(`table/users/auth/login-password`, {
        method: 'POST',
        body: JSON.stringify({email: userEmail, password: '12345678'}),
    })
    expect(oldLoginRes.status).toEqual(400)
    expect((await oldLoginRes.json() as any).message).toEqual('Invalid username or password')
})

test('request-password-reset throttles repeated requests', async () => {
    await createUser({})

    // First request should succeed
    const res1 = await fetchWithEmail(`table/users/auth/request-password-reset`, {
        method: 'POST',
        body: JSON.stringify({email: 'admin@example.com'}),
    })
    expect(res1.status).toEqual(200)

    // Second request within 2 minutes should be throttled
    const res2 = await fetchWithEmail(`table/users/auth/request-password-reset`, {
        method: 'POST',
        body: JSON.stringify({email: 'admin@example.com'}),
    })
    expect(res2.status).toEqual(400)
    const body2 = await res2.json() as any
    expect(body2.message).toEqual('Password reset email already sent')
})

test('confirm-password-reset with invalid token', async () => {
    const tok = testToken('invalid2')
    const res = await fetch(`table/users/auth/confirm-password-reset`, {
        method: 'POST',
        body: JSON.stringify({
            token: tok,
            password: 'newpassword123',
            passwordConfirm: 'newpassword123',
        }),
    })
    expect(res.status).toEqual(400)
    const body = await res.json() as any
    expect(body.message).toEqual('Invalid token')
})

test('confirm-password-reset with password mismatch', async () => {
    const json = await createUser({})
    const tok = testToken('mismtch1')
    await insertKvToken(tok, {
        id: json.record.id,
        sub: 'admin@example.com',
        typ: 'reset_password',
        cid: 'users',
    })

    const res = await fetch(`table/users/auth/confirm-password-reset`, {
        method: 'POST',
        body: JSON.stringify({
            token: tok,
            password: 'newpassword123',
            passwordConfirm: 'differentpassword',
        }),
    })
    expect(res.status).toEqual(400)
    const body = await res.json() as any
    expect(body.message).toEqual('Validation Error')
    expect(body.data).toEqual({_errors: [], passwordConfirm: { _errors: [ 'password and passwordConfirm do not match' ] }})
})

test('confirm-password-reset with expired token', async () => {
    const json = await createUser({})
    const tok = testToken('exprst01')
    await insertKvToken(tok, {
        id: json.record.id,
        sub: 'admin@example.com',
        typ: 'reset_password',
        cid: 'users',
    }, -10) // expired

    const res = await fetch(`table/users/auth/confirm-password-reset`, {
        method: 'POST',
        body: JSON.stringify({
            token: tok,
            password: 'newpassword123',
            passwordConfirm: 'newpassword123',
        }),
    })
    expect(res.status).toEqual(400)
    const body = await res.json() as any
    expect(body.message).toEqual('Invalid token')
})

test('confirm-password-reset token is consumed (single use)', async () => {
    const json = await createUser({})
    const tok = testToken('singler1')
    await insertKvToken(tok, {
        id: json.record.id,
        sub: 'admin@example.com',
        typ: 'reset_password',
        cid: 'users',
    })

    // First use should succeed
    const res1 = await fetch(`table/users/auth/confirm-password-reset`, {
        method: 'POST',
        body: JSON.stringify({
            token: tok,
            password: 'newpassword123',
            passwordConfirm: 'newpassword123',
        }),
    })
    expect(res1.status).toEqual(200)

    // Second use should fail
    const res2 = await fetch(`table/users/auth/confirm-password-reset`, {
        method: 'POST',
        body: JSON.stringify({
            token: tok,
            password: 'anotherpassword1',
            passwordConfirm: 'anotherpassword1',
        }),
    })
    expect(res2.status).toEqual(400)
    expect((await res2.json() as any).message).toEqual('Invalid token')
})

test('action mark_verified_stat steps mode', async () => {
    let json = await createUser({})
    let json3 = await createUser({username: 'admin2', email: 'admin2@example.com'})
    expect(json.verified).toEqual(false)
    const res1 = await fetch(`action/mark_verified_stat`, {
        method: 'POST',
        body: JSON.stringify({
            email: 'admin@example.com',
        }),
        headers: {'Authorization': 'Bearer ' + json.token,},
    })
    expect(res1.status).toEqual(200)

    const res2 = await fetch(`table/users/auth/login-password`, {
        method: 'POST',
        body: JSON.stringify({ email: 'admin@example.com', password: '12345678',}),
    })
    expect(res2.status).toEqual(200)
    const res2json = await res2.json() as any
    expect(res2json.token).toBeDefined()
    expect(res2json.record.email_verified).toEqual(true)
    expect(res2json.record.password).toBeUndefined()

    // Other user should NOT be affected
    const res3 = await fetch(`table/users/auth/login-password`, {
        method: 'POST',
        body: JSON.stringify({ email: 'admin2@example.com', password: '12345678',}),
    })
    expect(res3.status).toEqual(200)
    const res3json = await res3.json() as any
    expect(res3json.record.email_verified).toEqual(false)
    expect(res3json.record.password).toBeUndefined()
})

test('action requireAuth rejects unauthenticated requests', async () => {
    // mark_verified_stat has requireAuth: true
    const res = await fetch(`action/mark_verified_stat`, {
        method: 'POST',
        body: JSON.stringify({
            email: 'admin@example.com',
        }),
    })
    expect(res.status).toEqual(401)
})

test('action guard passes with authenticated user', async () => {
    // mark_verified_guarded has guard: "auth.uid != null"
    const json = await createUser({})
    const res = await fetch(`action/mark_verified_guarded`, {
        method: 'POST',
        body: JSON.stringify({
            email: 'admin@example.com',
            id: json.record.id,
        }),
        headers: {'Authorization': 'Bearer ' + json.token},
    })
    expect(res.status).toEqual(200)
    const resJson = (await res.json() as any)[0][0]
    expect(resJson.email_verified).toEqual(1)
})

test('action guard rejects unauthenticated user', async () => {
    // mark_verified_guarded has guard: "auth.uid != null" — no auth → 403
    const res = await fetch(`action/mark_verified_guarded`, {
        method: 'POST',
        body: JSON.stringify({
            email: 'admin@example.com',
            id: 'some-id',
        }),
    })
    expect(res.status).toEqual(403)
})
