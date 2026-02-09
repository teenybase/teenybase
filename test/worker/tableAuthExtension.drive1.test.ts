import {SELF} from "cloudflare:test";
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
            role: 'guest',
            ...data,
        }),
    })
    expect(res.status).toEqual(status)
    return await res.json() as any
}

test('sign up with password no name', async () => {
    const uid = "O-iV9qZXTMOp1U2VV5XC9Q"
    const json = await createUser({name: undefined, id: uid}, 400)
    // console.log(json)
    delete json.queries;
    expect(json).toEqual({
        code: 400,
        message: 'Failed to run insert query',
        data: {
            error: 'NOT NULL constraint failed: users.name: SQLITE_CONSTRAINT',
            input: `WITH [new] ([username], [email], [password], [role], [id], [email_verified]) AS (SELECT "admin", "admin@example.com", "ef797c8118f02dfb649607dd5d3f8c7623048c9c063d532cc95c5ed7a898a64f", "guest", "O-iV9qZXTMOp1U2VV5XC9Q", 0) INSERT INTO [users] ([username], [email], [password], [role], [id], [email_verified]) SELECT [username], [email], [password], [role], [id], [email_verified] FROM [new] WHERE (([new].[role]) = "guest") RETURNING [users].[id], [users].[username], [users].[email], [users].[email_verified], [users].[role], [users].[meta];`,
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
    await jwt.verify(json.token, authExt!.jwtSecret, {throwError: true})
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
    await jwt.verify(token, authExt!.jwtSecret, {throwError: true})
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
    await jwt.verify(json2.token, authExt!.jwtSecret, {throwError: true})
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
    await jwt.verify(json.token, authExt!.jwtSecret, {throwError: true})
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

test('rpc mark verified', async () => {
    let json = await createUser({})
    let json3 = await createUser({username: 'admin2', email: 'admin2@example.com'})
    expect(json.verified).toEqual(false)
    // console.log(json)
    const res1 = await fetch(`rpc/mark_verified`, {
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
    // todo this should be undefined
    expect(res1json.password).toBeDefined() // shouldn't return the password when * is used...

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
    const res1 = await fetch(`rpc/mark_verified`, {
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
        }),
        headers: {'Authorization': 'Bearer ' + res2json.token,},
    })
    expect(res.status).toEqual(400)
    json = await res.json()
    expect(json.message).toEqual('passwordCurrent is required') // todo proper validation error here.

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
    expect(json.data).toEqual({_errors: [], passwordConfirm: { _errors: [ 'password and passwordConfirm do not match' ] }})

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

// todo
// test('rpc mark verified statement', async () => {
//     let json = await createUser({})
//     let json2 = await createUser({username: 'admin1', email: 'admin1@example.com'})
//     let json3 = await createUser({username: 'admin2', email: 'admin2@example.com'})
//     expect(json.verified).toEqual(false)
//     // console.log(json)
//     const res1 = await fetch(`rpc/mark_verified_stat`, {
//         method: 'POST',
//         body: JSON.stringify({
//             email: 'admin@example.com',
//         }),
//         headers: {'Authorization': 'Bearer ' + json.token,},
//     })
//     expect(res1.status).toEqual(200)
//     const res1json = (await res1.json() as any)[0][0]
//     // todo this should be `true`
//     expect(res1json.email_verified).toEqual(1)
//     expect(res1json.password).toBeUndefined() // shouldn't return the password when * is used...
//
//     const res2 = await fetch(`table/users/auth/login-password`, {
//         method: 'POST',
//         body: JSON.stringify({ email: 'admin@example.com', password: '12345678',}),
//     })
//     expect(res2.status).toEqual(200)
//     const res2json = await res2.json() as any
//     console.log(res2json)
//     expect(res2json.token).toBeDefined()
//     expect(res2json.record.email_verified).toEqual(true)
//     expect(res2json.record.password).toBeUndefined()
//
//     const res3 = await fetch(`table/users/auth/login-password`, {
//         method: 'POST',
//         body: JSON.stringify({ email: 'admin2@example.com', password: '12345678',}),
//     })
//     expect(res3.status).toEqual(200)
//     const res3json = await res3.json() as any
//     expect(res3json.record.email_verified).toEqual(false)
//     expect(res3json.record.password).toBeUndefined()
//
// })
