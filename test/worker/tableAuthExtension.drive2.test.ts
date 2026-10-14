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

const fetch = (input: RequestInfo, init?: RequestInit)=>{
    const headers = {
        '$DB_TEST_DATABASE_SETTINGS': JSON.stringify(settings),
    } as Record<string, string>
    const cType = init?.method === 'POST' && typeof init?.body === 'string' ? 'application/json' : init?.body instanceof FormData ? undefined : 'text/plain'
    if(cType && !headers['Content-Type']) headers['Content-Type'] = cType
    return SELF.fetch('https://example.com/api/v1/table/'+input, {...init, ...{
            headers: {
                ...init?.headers,
                ...headers,
            }
        }})
}
const fetch2 = (input: RequestInfo, init?: RequestInit)=>{
    const headers = {
        '$DB_TEST_DATABASE_SETTINGS': JSON.stringify(settings),
    } as Record<string, string>
    return SELF.fetch('https://example.com/'+input, {...init, ...{
            headers: {
                ...init?.headers,
                ...headers,
            }
        }})
}

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
    expect(json.data).toEqual({_errors: [], passwordConfirm: { _errors: [ 'passwordConfirm is required' ] }})
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
            meta: '{"base": "/"}',
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
    const json = await createUser({name: undefined, id: uid, password_salt}, 401)
    expect(json).toEqual({
        code: 401,
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
    await jwt.verify(json.token, settings.jwtSecret + authExt.jwtSecret, {throwError: true})
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

test('sign up with password - fail base', async () => {
    const res = await createUser({meta: '{"base": ""}'}, 400)
    // todo need to know it's because of rule fail
    expect(res.message).toEqual('Unable to create user')
})

test('sign up with password - invalid field', async () => {
    const res = await createUser({base: 'test'}, 400)
    expect(res.message).toEqual('Invalid field base')
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
    const token = json.token
    expect(token).toBeDefined()
    await jwt.verify(token, settings.jwtSecret + authExt.jwtSecret, {throwError: true})
    const decode = jwt.decode(token).payload!
    const sid = (decode as any).sid
    expect(sid).toMatch(/[A-Za-z0-9\-_]{21}/)
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

    const res2 = await fetch(`users/auth/refresh-token`, {
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
    expect((decode2 as any).sid).toEqual(sid) // same session id
})

test('login with pass admin', async () => {
    const res = await fetch(`users/auth/login-password`, {
        method: 'POST',
        body: JSON.stringify({username: 'suadmin', password: 'password123',}),
    })
    expect(res.status).toEqual(200)
    const json = await res.json() as any
    const authExt = settings.tables.find(t=>t.name==='users')?.extensions.find(e=>e.name==='auth') as TableAuthExtensionData
    expect(authExt).toBeDefined()
    await jwt.verify(json.token, settings.jwtSecret + authExt.jwtSecret, {throwError: true})
    const decode = jwt.decode(json.token).payload! as any
    delete decode.iat
    delete decode.exp
    expect(decode.sid).toMatch(/[A-Za-z0-9\-_]{21}/)
    delete decode.sid
    expect(decode).toEqual({
        cid: 'users',
        user: 'suadmin',
        sub: 'admin@admin.com',
        id: 'suadmin',
        meta: { base: '/' },
        aud: [ 'superadmin' ],
        verified: true,
        iss: '$db'
    })
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
    expect(json).toEqual([{"username":"a","email":"admin@example.com","email_verified":0,"name":"Admin User","avatar":null,"role":"guest","meta":"{\"base\": \"/\"}"}])
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

test('list files', async () => {
    const token = await createUser({username: 'a'})
    const res = await fetch(`files/select?select=name,path`, {
        method: 'GET',
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    expect(res.status).toEqual(200)
    expect(await res.text()).toEqual('[]')
    const res2 = await fetch(`users/auth/login-password`, {
        method: 'POST',
        body: JSON.stringify({username: 'suadmin', password: 'password123',}),
    })
    expect(res2.status).toEqual(200)
    const token2 = await res2.json() as any
    const res3 = await fetch(`files/select?select=name,path`, {
        method: 'GET',
        headers: {'Authorization': 'Bearer ' + token2.token},
    })
    expect(res3.status).toEqual(200)
    expect(await res3.text()).toEqual('[{"name":"Test File","path":"/test/"}]')
})

test('list files no token', async () => {
    const res = await fetch(`files/select?select=name,path`, {
        method: 'GET',
    })
    expect(res.status).toEqual(200)
    expect(await res.text()).toEqual('[]')
})

// this could break if bug in rules/simplification
test('list files no token 2', async () => {
    const res = await fetch(`files/select?select=name,path&where=${encodeURIComponent("id='test'")}`, {
        method: 'GET',
    })
    expect(res.status).toEqual(200)
    expect(await res.text()).toEqual('[]')
})

test('view file no token', async () => {
    const res = await fetch(`files/view/test`, {
        method: 'GET',
    })
    expect(res.status).toEqual(404)
    const json = await res.json()
    expect(json).toEqual({
        code: 404,
        message: 'Not found',
        data: {},
        queries: [
            'SELECT [files].[id], [files].[created], [files].[updated], [files].[created_by], [files].[path], [files].[name], [files].[thumb], [files].[file], [files].[notes], [files].[config], [files].[meta], [files].[tags], [files].[deleted_by], [files].[deleted_at] FROM [files] WHERE 0 LIMIT 1;'
        ]
    })
})

test('view file', async () => {
    const token = await createUser({username: 'a'})
    const res = await fetch(`files/view/test?select=*`, {
        method: 'GET',
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    expect(res.status).toEqual(200)
    const json = await res.json() as any
    delete json.created
    delete json.updated
    expect(json).toEqual({
        id: 'test',
        created_by: null,
        path: '/test/',
        name: 'Test File',
        thumb: null,
        file: 'test.txt',
        notes: '',
        config: '{}',
        meta: '{}',
        tags: null,
        deleted_by: null,
        deleted_at: null
    })
})

test('insert nothing', async () => {
    const token = await createUser({username: 'admin'})
    const res = await fetch(`files/insert`, {
        method: 'POST',
        body: JSON.stringify({
            values: [],
            returning: ['id']
        }),
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    expect(res.status).toEqual(200)
    expect(await res.text()).toEqual('[]')
})

// todo this fails because referencing path in rules but not passing here, need to fix or improve the error report or something
// test('insert empty', async () => {
//     const token = await createUser({username: 'admin'})
//     const res = await fetch(`files/insert`, {
//         method: 'POST',
//         body: JSON.stringify({
//             values: {},
//             returning: ['id']
//         }),
//         headers: {'Authorization': 'Bearer ' + token.token},
//     })
//     expect(res.status).toEqual(200)
//     expect(await res.text()).toEqual('[]') // should have one default record
// })

async function insertDummyFile() {
    const token = await createUser({username: 'admin'})
    const table = 'files'

    const data = new FormData();
    data.append("values.created_by", token.record.id);
    data.append("values.file", new File(['test content'], 'test.txt', {type: 'text/plain; charset=utf-8'}));
    data.append("values.path", 'test');
    data.append("values.name", 'Test file');
    data.append("values.tags", 'asd');
    data.append("returning", ['path', 'name', 'id', 'file'].join(','));

    console.log(data)

    const res = await fetch(`${table}/insert`, {
        method: 'POST',
        body: data,
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    return {token, table, res}
}

test('insert file', async () => {
    const {token, table, res} = await insertDummyFile()
    const json = await res.json() as any
    expect(json.length).toEqual(1)
    const rid = json[0].id
    expect(rid.length).toEqual('NPH_VLntSPKZnsM-tlUXRw'.length)
    delete json[0].id
    const f = json[0].file
    expect(f).toMatch(/test_[a-z0-9]{10}\.txt/)
    delete json[0].file
    expect(json).toEqual([{
        "path":"test","name":"Test file",
    }])
    const headers = res.headers
    expect(headers.get('x-uploaded-files')).toEqual(`{${JSON.stringify(`${table}/`+f)}:"test.txt"}`)
    expect(headers.get('x-deleted-files')).toBeNull()

    // download file
    const res2 = await fetch2(`api/v1/files/${table}/${rid}/${f}`, {
        method: 'GET',
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    console.log(res2.status)
    expect(res2.status).toEqual(200)
    expect(await res2.text()).toEqual('test content')
    expect(res2.headers.get('Content-Type')).toEqual('text/plain; charset=utf-8')
})

test('insert multiple files', async () => {
    const token = await createUser({username: 'admin'})
    const table = 'files'

    const data = new FormData();

    const payload = {values: [] as any}
    for (let i = 0; i < 10; i++) {
        data.append(`@filePayload`, new File([`test=${i+1}`], 'test.txt', {type: 'text/plain; charset=utf-8'}));
        payload.values.push({
            created_by: token.record.id,
            file: `@filePayload.${i}`,
            path: `test${i}`,
            name: `Test file ${i+1}`,
            tags: 'asd',
        })
    }
    data.append("returning", ['path', 'name', 'id', 'file'].join(','));
    data.append("@jsonPayload", JSON.stringify(payload));

    // console.log(data)

    const res = await fetch(`${table}/insert`, {
        method: 'POST',
        body: data,
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    const json = await res.json() as any
    expect(json.length).toEqual(10)

    const headers = res.headers
    const uploadedHeader = JSON.parse(headers.get('x-uploaded-files') ?? '{}')
    expect(headers.get('x-deleted-files')).toBeNull()

    await Promise.all(json.map(async (js: any, i: number)=>{
        const rid = js.id
        expect(rid.length).toEqual('NPH_VLntSPKZnsM-tlUXRw'.length)
        delete js.id
        const f = js.file
        expect(f).toMatch(/test_[a-z0-9]{10}\.txt/)
        delete js.file
        expect(js).toEqual({
            "path":`test${i}`,"name":`Test file ${i+1}`,
        })

        expect(uploadedHeader[`${table}/`+f]).toEqual("test.txt")

        // download file
        const res2 = await fetch2(`api/v1/files/${table}/${rid}/${f}`, {
            method: 'GET',
            headers: {'Authorization': 'Bearer ' + token.token},
        })
        console.log(res2.status)
        expect(res2.status).toEqual(200)
        const text = await res2.text()
        console.log(rid, text)
        expect(text).toEqual(`test=${i+1}`)
        expect(res2.headers.get('Content-Type')).toEqual('text/plain; charset=utf-8')
    }))

})

test('insert and update, remove file', async () => {
    const {token, table, res} = await insertDummyFile()
    const json = await res.json() as any

    // update
    const data = new FormData();
    data.append("where", `id='${json[0].id}'`);
    data.append("setValues.file", new File(['updated content'], 'test.txt', {type: 'text/plain; charset=utf-8'}));
    data.append("returning", ['path', 'name', 'id', 'file'].join(','));
    console.log(data)
    const res2 = await fetch(`${table}/update`, {
        method: 'POST',
        body: data,
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    expect(res2.status).toEqual(200)
    const json2 = await res2.json() as any
    expect(json2.length).toEqual(1)
    const rid = json2[0].id
    expect(rid.length).toEqual('NPH_VLntSPKZnsM-tlUXRw'.length)
    const f = json2[0].file
    expect(f).toMatch(/test_[a-z0-9]{10}\.txt/)
    delete json2[0].id
    delete json2[0].file
    expect(json2).toEqual([{
        "path":"test","name":"Test file",
    }])
    let headers = res2.headers
    expect(headers.get('x-uploaded-files')).toEqual(`{${JSON.stringify(`${table}/`+f)}:"test.txt"}`)
    expect(headers.get('x-deleted-files')).toEqual(`[${JSON.stringify(`${table}/${json[0].file}`)}]`)

    // download file
    const res3 = await fetch2(`api/v1/files/${table}/${rid}/${f}`, {
        method: 'GET',
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    expect(res3.status).toEqual(200)
    expect(await res3.text()).toEqual('updated content')
    expect(res3.headers.get('Content-Type')).toEqual('text/plain; charset=utf-8')

    // delete file by setting file to null/@null (empty string will not work)
    const data2 = new FormData();
    // data2.append("values.id", json[0].id);
    data2.append("where", `id='${json[0].id}'`);
    data2.append("setValues.file", '@null');
    data2.append("returning", ['path', 'name', 'id', 'file'].join(','));
    const res4 = await fetch(`${table}/update`, {
        method: 'POST',
        body: data2,
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    expect(res4.status).toEqual(200)
    const json4 = await res4.json() as any
    expect(json4.length).toEqual(1)
    const rid2 = json4[0].id
    expect(rid2.length).toEqual('NPH_VLntSPKZnsM-tlUXRw'.length)
    expect(json4[0].file).toBeNull()
    headers = res4.headers
    expect(headers.get('x-uploaded-files')).toBeNull()
    expect(headers.get('x-deleted-files')).toEqual(`[${JSON.stringify(`${table}/${f}`)}]`)

})

test('insert and delete file', async () => {
    const {token, table, res} = await insertDummyFile()
    const json = await res.json() as any

    // delete file row
    const data = new FormData();
    data.append("where", `id='${json[0].id}'`);
    data.append("returning", ['path', 'name', 'id', 'file'].join(','));
    console.log(data)
    const res2 = await fetch(`${table}/delete`, {
        method: 'POST',
        body: data,
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    expect(res2.status).toEqual(200)
    const json2 = await res2.json() as any
    expect(json2.length).toEqual(1)
    const rid = json2[0].id
    expect(rid.length).toEqual('NPH_VLntSPKZnsM-tlUXRw'.length)
    const f = json2[0].file
    expect(f).toMatch(/test_[a-z0-9]{10}\.txt/)
    expect(f).toEqual(json[0].file)
    delete json2[0].id
    delete json2[0].file
    expect(json2).toEqual([{
        "path":"test","name":"Test file",
    }])
    let headers = res2.headers
    expect(headers.get('x-uploaded-files')).toBeNull()
    expect(headers.get('x-deleted-files')).toEqual(`[${JSON.stringify(`${table}/${f}`)}]`)

    // download file
    const res3 = await fetch2(`api/v1/files/${table}/${rid}/${f}`, {
        method: 'GET',
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    expect(res3.status).toEqual(404)
    expect(await res3.json()).toEqual({"code":404,"message":"File not found","data":{},"queries":[`STORAGE: getFileObject: ${table}/${f}`]})

})

test('insert file fail', async () => {
    const token = await createUser({username: 'a'})

    const data = new FormData();
    data.append("values.created_by", token.record.id);
    data.append("values.file",new File(['test content'], 'test.txt', {type: 'text/plain'}));
    data.append("values.path", 'test');
    data.append("values.name", 'Test file');
    data.append("values.tags", 'asd');
    data.append("returning", ['path', 'name', 'id', 'file'].join(','));

    console.log(data)

    const res = await fetch(`files/insert`, {
        method: 'POST',
        body: data,
        headers: {'Authorization': 'Bearer ' + token.token},
    })
    const json = await res.json() as any
    expect(json).toEqual([])
    const headers = res.headers
    expect(headers.get('x-uploaded-files')).toBeNull()
    expect(headers.get('x-deleted-files')).toBeNull()
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
