import {SELF} from "cloudflare:test";
import {beforeAll, expect, test} from "vitest";
import {setup} from '../data/drive2/setup'
import * as jwt from '@tsndr/cloudflare-worker-jwt';
import {TableAuthExtensionData} from '../../src'

let settings: Awaited<ReturnType<typeof setup>>
beforeAll(async () => {
    settings = await setup()
    console.log('Before All - Setup Drive 2')
})

const fetch = (input: RequestInfo, init?: RequestInit)=>SELF.fetch('https://example.com/api/v1/table/'+input, {...init, ...{
        headers: {
            ...init?.headers,
            '$DB_TEST_DATABASE_SETTINGS': JSON.stringify(settings),
            'Content-Type': init?.method === 'POST' ? 'application/json' : 'text/plain',
        }
    }})

// mostly same as drive1 with some changes and some at the bottom
// todo make some tests for file upload and download

test('without auth should fail', async () => {
    const res = await fetch(`users/select?limit=4&select=name,email&where=${encodeURIComponent(`name~'%o%'`)}`)
    expect(res.status).toEqual(200)
    const json = (await res.json() as any)
    expect(json).toEqual([])
})

test('sign up user fail no confirm', async () => {
    const res = await fetch(`users/auth/sign-up`, {
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
    const res = await fetch(`users/auth/sign-up`, {
        method: 'POST',
        body: JSON.stringify({
            username: 'admin',
            email: 'admin@example.com',
            password: '12345678',
            passwordConfirm: '12345678',
            name: 'Admin User',
            role: 'guest',
            meta: '{}',
            ...data,
        }),
    })
    if(res.status !== status) console.log(JSON.stringify(await res.json(), null, 2))
    expect(res.status).toEqual(status)
    return await res.json() as any
}

test('throw on insert password_salt', async () => {
    const uid = "O-iV9qZXTMOp1U2VV5XC9Q"
    const password_salt = "O-iV9qZXTMOp1U2VV5XC9Q"
    const json = await createUser({name: undefined, id: uid, password_salt}, 400)
    expect(json).toEqual({
        code: 400,
        "data": {},
        "message": "Cannot insert password_salt field",
        "queries": [],
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

test('sign up with password - fail role', async () => {
    const res = await createUser({role: ''}, 400)
    expect(res.message).toEqual('Unable to create user')
})

test('sign up with password - fail', async () => {
    const res = await createUser({password: '123'}, 400)
    expect(res.message).toEqual('Validation Error')
    expect(res.data).toEqual({_errors: [], password: { _errors: [ 'Password must be at least 8 characters long' ] }})
})

test('login with pass - wrong pass', async () => {
    await createUser({username: 'a'})

    const res = await fetch(`users/auth/login-password`, {
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

    const res = await fetch(`users/auth/login-password`, {
        method: 'POST',
        body: JSON.stringify({username: 'a', password: '12345678',}),
    })
    expect(res.status).toEqual(200)
    const json = await res.json() as any
    const authExt = settings.tables.find(t=>t.name==='users')?.extensions.find(e=>e.name==='auth') as TableAuthExtensionData
    expect(authExt).toBeDefined()
    await jwt.verify(json.token, authExt!.jwtSecret, {throwError: true})
    const decode = jwt.decode(json.token).payload!
    // console.log(decode)
    expect(decode.aud).toEqual(['guest'])
    expect((decode as any).verified).toEqual(false)
    expect((decode as any).cid).toEqual('users')
    expect(decode.sub).toEqual('admin@example.com')

    const res2 = await fetch(`users/auth/login-token`, {
        method: 'POST',
        headers: {'Authorization': 'Bearer ' + json.token,},
    })
    expect(res2.status).toEqual(200)
    const json2 = await res2.json() as any
    expect(json.token).not.toEqual(json2.token)
    await jwt.verify(json2.token, authExt!.jwtSecret, {throwError: true})
    const decode2 = jwt.decode(json2.token).payload!
    // console.log(decode2)
    expect((decode2 as any).rc).toEqual(1)
    expect((decode2 as any).cid).toEqual('users')
    expect(decode2.sub).toEqual('admin@example.com')
})

test('list users - *', async () => {
    const token = await createUser({username: 'a'})

    const res = await fetch(`users/select`, {
        method: 'GET',
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    expect(res.status).toEqual(200)
    const json = await res.json()
    for (const jsonElement of json as any[]) {
        delete jsonElement.id
        delete jsonElement.created
        delete jsonElement.updated
        // password should not be in the json since noSelect is true
    }
    // console.log(JSON.stringify(json))
    expect(json).toEqual([{"username":"a","email":"admin@example.com","email_verified":0,"name":"Admin User","avatar":null,"role":"guest","meta":"{}"}])
})
test('list users', async () => {
    const token = await createUser({username: 'a'})
    const res = await fetch(`users/select?select=name,username,email`, {
        method: 'GET',
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    expect(res.status).toEqual(200)
    expect(await res.text()).toEqual('[{"name":"Admin User","username":"a","email":"admin@example.com"}]')
})


test('list drive_config', async () => {
    const token = await createUser({username: 'guest'})
    const res = await fetch(`drive_config/select?select=id,val`, {
        method: 'GET',
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    expect(res.status).toEqual(200)
    expect(await res.text()).toEqual('[{"id":"app-name","val":"Drive"},{"id":"logo","val":""},{"id":"favicon","val":""},{"id":"api-version","val":"v1"},{"id":"language","val":"en-US"},{"id":"plan","val":"{\\"name\\":\\"Free\\",\\"storage-limit-mb\\":10000,}"},{"id":"metadata","val":"{\\"password\\":\\"secret-0\\"}"}]')
})

test('list drive_config admin', async () => {
    const token = await createUser({username: 'admin'})
    const res = await fetch(`drive_config/select?select=id,val`, {
        method: 'GET',
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    expect(res.status).toEqual(200)
    expect(await res.text()).toEqual('[{"id":"app-name","val":"Drive"},{"id":"logo","val":""},{"id":"favicon","val":""},{"id":"api-version","val":"v1"},{"id":"language","val":"en-US"},{"id":"plan","val":"{\\"name\\":\\"Free\\",\\"storage-limit-mb\\":10000,}"},{"id":"metadata","val":"{\\"password\\":\\"secret-0\\"}"},{"id":"secret-0","val":"khdgx238ewgxjcxiwdbcwe8gc"},{"id":"secret-1","val":"be8dg2393uwqnxqoug21z7"}]')
})


test('insert, update, delete drive_config admin', async () => {
    const token = await createUser({username: 'admin'})

    const insert = await fetch(`drive_config/insert`, {
        method: 'POST',
        body: JSON.stringify({
            values: [{
                id: "test1",
                val: "12345",
                protected: false,
            }, {
                id: "test2",
                val: "asdfgh",
                protected: true,
            }],
            returning: ['id', 'val']
        }),
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    expect(insert.status).toEqual(200)
    expect(await insert.json()).toEqual([ { id: 'test1', val: '12345' }, { id: 'test2', val: 'asdfgh' } ])

    const update = await fetch(`drive_config/update`, {
        method: 'POST',
        body: JSON.stringify({
            set: {
                val: 'concat(id,val,"111")',
            },
            where: 'id ~"test%"',
            returning: ['id', 'val']
        }),
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    expect(update.status).toEqual(200)
    expect(await update.json()).toEqual([ { id: 'test1', val: 'test112345111' }, { id: 'test2', val: 'test2asdfgh111' } ])

    const deleted = await fetch(`drive_config/delete`, {
        method: 'POST',
        body: JSON.stringify({
            where: 'id~"test%" & !protected',
            returning: ['id', 'val']
        }),
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    expect(deleted.status).toEqual(200)
    expect(await deleted.json()).toEqual([ { id: 'test1', val: 'test112345111' } ])

    const res = await fetch(`drive_config/select?select=id,val`, {
        method: 'GET',
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    expect(res.status).toEqual(200)
    expect(await res.json()).toEqual([
        { id: 'app-name', val: 'Drive' },
        { id: 'logo', val: '' },
        { id: 'favicon', val: '' },
        { id: 'api-version', val: 'v1' },
        { id: 'language', val: 'en-US' },
        { id: 'plan', val: '{"name":"Free","storage-limit-mb":10000,}' },
        { id: 'metadata', val: '{"password":"secret-0"}' },
        { id: 'secret-0', val: 'khdgx238ewgxjcxiwdbcwe8gc' },
        { id: 'secret-1', val: 'be8dg2393uwqnxqoug21z7' },
        { id: 'test2', val: 'test2asdfgh111' }
    ])
})
