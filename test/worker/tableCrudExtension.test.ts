import {SELF} from "cloudflare:test";
import {beforeAll, expect, test} from "vitest";
import {DatabaseSettings} from '../../src'
import {setup} from '../data/test1/setup'

let settings: DatabaseSettings
beforeAll(async () => {
    settings = await setup()
    console.log('Before All - Setup Test 1')
})

const basePath = 'https://localhost/api/v1/table'

const fetch = (input: RequestInfo, init?: RequestInit)=>SELF.fetch(input, {...init, ...{
        headers: {
            'Content-Type': init?.method === 'POST' ? 'application/json' : 'text/plain',
            ...init?.headers,
            '$DB_TEST_DATABASE_SETTINGS': JSON.stringify(settings),
        }
    }})

test('select with filters get', async () => {
    const res = await fetch(`${basePath}/users/select?limit=4&select=uid,name,email&order=uid&where=${encodeURIComponent(`name~'%o%'`)}`)
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"uid":"alice101","name":"Alice Brown","email":"alice@example.com"},{"uid":"bob789","name":"Bob Johnson","email":"bob@example.com"},{"uid":"eva303","name":"Eva Wilson","email":"eva@example.com"},{"uid":"henry606","name":"Henry Taylor","email":"henry@example.com"}]`)
    // console.log(JSON.parse(json))
})

test('select with filters get 2', async () => {
    const res = await fetch(`${basePath}/users/select?select=uid,users.id&order=name&where=${encodeURIComponent(`name~'%o%'&id>5`)}`)
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"uid":"eva303","id":6},{"uid":"henry606","id":9}]`)
    // console.log(JSON.parse(json))
})

test('select count id', async () => {
    const res = await fetch(`${basePath}/users/select?select=count(id)=>count`)
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"count":10}]`)
    // console.log(JSON.parse(json))
})

test('select count all', async () => {
    const res = await fetch(`${basePath}/users/select?select=count()`)
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"COUNT(*)":10}]`)
    // console.log(JSON.parse(json))
})

// test('select with join', async () => {
//     const res = await fetch(`${basePath}/users/select?select=users.uid,files.id&join=files.user_id=users.id&where=${encodeURIComponent(`users.id=1`)}`)
//     const json = (await res.text()).trim()
//     console.log(json)
//     expect(res.status).toEqual(200)
//     expect(json).toEqual(`[{"uid":"john123","id":1}]`)
//     console.log(JSON.parse(json))
// })

test('select with filters post', async () => {
    const res = await fetch(`${basePath}/users/select`, {
        method: 'POST',
        body: JSON.stringify({
            limit: 4,
            select: ['uid', 'name', 'email'],
            order: 'uid',
            where: `name~'%o%'`
        })
    })
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"uid":"alice101","name":"Alice Brown","email":"alice@example.com"},{"uid":"bob789","name":"Bob Johnson","email":"bob@example.com"},{"uid":"eva303","name":"Eva Wilson","email":"eva@example.com"},{"uid":"henry606","name":"Henry Taylor","email":"henry@example.com"}]`)
    // console.log(JSON.parse(json))
})

test('insert single', async () => {
    const res = await fetch(`${basePath}/users/insert`, {
        method: 'POST',
        body: JSON.stringify({
            values: {
                ['uid']: 'test123',
                name: 'Test Name',
                email: 'test@example.com',
                pass_hash: 'babababaaaa',
            },
            returning: ['id', 'uid', 'name', 'email']
        }),
    })
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"id":11,"uid":"test123","name":"Test Name","email":"test@example.com"}]`)
    const js = JSON.parse(json)[0]
    const res2 = await fetch(`${basePath}/users/select?select=id,uid,name,email&where=${encodeURIComponent(`id=`+js.id)}`)
    const json2 = (await res2.text()).trim()
    // console.log(json2)
    expect(res2.status).toEqual(200)
    expect(json2).toEqual(json)
})

test('insert twice', async () => {
    const req = {
        method: 'POST',
        body: ({
            values: {
                ['uid']: 'test123',
                name: 'Test Name',
                email: 'test@example.com',
                pass_hash: 'babababaaaa',
            },
            returning: ['id', 'uid', 'name', 'email'],
            // or: 'ABORT',
        }),
    }
    const res = await fetch(`${basePath}/users/insert`, {...req, body: JSON.stringify(req.body)})
    expect(res.status).toEqual(200)
    expect(await res.json()).toEqual([{"id":11,"uid":"test123","name":"Test Name","email":"test@example.com"}])
    const count = await fetch(`${basePath}/users/select?select=count(id)=>c`)
    expect((await count.json() as any)[0].c).toEqual(11)

    req.body.values.name = 'Name 2'

    // fail
    const res2 = await fetch(`${basePath}/users/insert`, {...req, body: JSON.stringify(req.body)})
    const json = (await res2.json()) as any
    expect(json.code).toEqual(400)
    expect(json.message).toEqual('Failed to run insert query')
    expect(json.data.error).toEqual('UNIQUE constraint failed: users.uid: SQLITE_CONSTRAINT')
    expect(json.data.uid).toEqual({
        code: 'SQLITE_CONSTRAINT',
        message: 'A record with this value already exists.'
    })

    // INSERT or REPLACE
    // @ts-ignore
    req.body.or = 'REPLACE'
    // @ts-ignore
    const res3 = await fetch(`${basePath}/users/insert`, {...req, body: JSON.stringify(req.body)})
    expect(res3.status).toEqual(200)
    const json2 = await res3.json()
    // id will be incremented, previous record will be deleted
    expect(json2).toEqual([{"id":12,"uid":"test123","name":"Name 2","email":"test@example.com"}])

    const count2 = await fetch(`${basePath}/users/select?select=count(id)=>c`)
    expect((await count2.json() as any)[0].c).toEqual(11)
    const last = await fetch(`${basePath}/users/select?select=id&where=${encodeURIComponent(`id=11`)}`)
    expect(await last.json()).toEqual([])

})

test('insert multiple', async () => {
    const time = Date.now() / 1000
    await new Promise((r) => setTimeout(r, 1000))
    const res = await fetch(`${basePath}/users/insert`, {
        method: 'POST',
        body: JSON.stringify({
            values: [{
                ['uid']: 'test123',
                name: 'Test Name',
                email: 'test@example.com',
                pass_hash: 'babababaaaa',
            }, {
                ['uid']: 'test121',
                name: 'Test Name2',
                email: 'test@example2.com',
                pass_hash: 'aaababababe',
            }],
            returning: ['id', 'pass_hash']
        }),
    })
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"id":11,"pass_hash":"babababaaaa"},{"id":12,"pass_hash":"aaababababe"}]`)
    const res2 = await fetch(`${basePath}/users/select?select=id,pass_hash&where=${encodeURIComponent(`unixepoch(created)>=${time}`)}`)
    const json2 = (await res2.text()).trim()
    // console.log(JSON.parse(json2))
    expect(res2.status).toEqual(200)
    expect(json2).toEqual(json)
})

test('update single setValues', async () => {
    const res = await fetch(`${basePath}/users/update`, {
        method: 'POST',
        body: JSON.stringify({
            setValues: {
                name: 'Test Name Updated',
                email: 'test@example.com',
            },
            where: `uid='john123'`,
            returning: ['id', 'uid', 'name', 'email']
        }),
    })
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"id":1,"uid":"john123","name":"Test Name Updated","email":"test@example.com"}]`)
    const js = JSON.parse(json)[0]
    const res2 = await fetch(`${basePath}/users/select?select=id,uid,name,email&where=${encodeURIComponent(`id=`+js.id)}`)
    const json2 = (await res2.text()).trim()
    // console.log(json2)
    expect(res2.status).toEqual(200)
    expect(json2).toEqual(json)
})

test('edit, view', async () => {
    const res = await fetch(`${basePath}/users/edit/1?returning=id,uid,name,email`, {
        method: 'POST',
        body: JSON.stringify({
            name: 'Test Name Updated',
            email: 'test@example.com',
        }),
    })
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`{"id":1,"uid":"john123","name":"Test Name Updated","email":"test@example.com"}`)
    const res2 = await fetch(`${basePath}/users/view/1?select=id,uid,name,email`)
    const json2 = (await res2.text()).trim()
    // console.log(json2)
    expect(res2.status).toEqual(200)
    expect(json2).toEqual(json)
})

test('edit, view + where', async () => {
    const res = await fetch(`${basePath}/users/edit/1?returning=id,uid,name,email`, {
        method: 'POST',
        body: JSON.stringify({
            name: 'Test Name Updated',
            email: 'test@example.com',
        }),
    })
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`{"id":1,"uid":"john123","name":"Test Name Updated","email":"test@example.com"}`)
    const res2 = await fetch(`${basePath}/users/view/1?select=id,uid,name,email&where=${encodeURIComponent(`name~"%Updated"`)}`)
    const json2 = (await res2.text()).trim()
    expect(res2.status).toEqual(200)
    expect(json2).toEqual(json)
    const res3 = await fetch(`${basePath}/users/view/1?select=id,uid,name,email&where=${encodeURIComponent(`name~"%1Updated"`)}`)
    const json3 = (await res3.text()).trim()
    expect(json3).toEqual(`{"code":404,"message":"Not found","data":{},"queries":["SELECT [users].[id], [users].[uid], [users].[name], [users].[email] FROM [users] WHERE (((([users].[id]) = 1) AND (([users].[name]) LIKE \\"%1Updated\\" ESCAPE '\\\\')) AND (1)) LIMIT 1;"]}`)
    expect(res3.status).toEqual(404)
})

test('edit formdata', async () => {
    const formData = new FormData()
    formData.append('name', 'Test Name Updated')
    formData.append('email', 'test@example.com')
    const res = await SELF.fetch(`${basePath}/users/edit/1?returning=id,uid,name,email`, {
        method: 'POST',
        body: formData,
        headers: {
            '$DB_TEST_DATABASE_SETTINGS': JSON.stringify(settings),
        }
    })
    const json = (await res.text()).trim()
    expect(res.status).toEqual(200)
    expect(json).toEqual(`{"id":1,"uid":"john123","name":"Test Name Updated","email":"test@example.com"}`)
})


test('update single set', async () => {
    const res = await fetch(`${basePath}/users/update`, {
        method: 'POST',
        body: JSON.stringify({
            set: {
                name: 'concat(name,"1") || 100',
                email: '"test@example.com"',
            },
            where: `uid='john123' & name='John Doe'`,
            returning: ['id', 'uid', 'name']
        }),
    })
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"id":1,"uid":"john123","name":"John Doe1100.0"}]`)
    const js = JSON.parse(json)[0]
    const res2 = await fetch(`${basePath}/users/select?select=id,uid,name&where=${encodeURIComponent(`name="${js.name}"`)}`)
    const json2 = (await res2.text()).trim()
    // console.log(json2)
    expect(res2.status).toEqual(200)
    expect(json2).toEqual(json)
})

test('update multiple set', async () => {
    const res = await fetch(`${basePath}/users/update`, {
        method: 'POST',
        body: JSON.stringify({
            set: {
                name: 'concat(name,"1") || 100', // || is also concat
            },
            where: 'id < 4 & new.name~"%.0" & new.id = id',
            returning: '*',
        }),
    })
    const json = (await res.text()).trim()
    expect(res.status).toEqual(200)
    const data = JSON.parse(json)
    expect(data.length).toEqual(3)
    Object.values(data).forEach((d: any) => {delete d.created; delete d.updated})
    expect(data).toEqual([{"id":1,"name":"John Doe1100.0","email":"john@example.com","uid":"john123","pass_hash":"hash1"},{"id":2,"name":"Jane Smith1100.0","email":"jane@example.com","uid":"jane456","pass_hash":"hash2"},{"id":3,"name":"Bob Johnson1100.0","email":"bob@example.com","uid":"bob789","pass_hash":"hash3"}])
})

test('delete single', async () => {
    const id = '1'
    const res1 = await fetch(`${basePath}/files/select?select=count(id)&where=${encodeURIComponent(`user_id='${id}'`)}`)
    const json1 = (await res1.text()).trim()
    // console.log(json1)
    expect(res1.status).toEqual(200)
    expect(json1).toEqual(`[{"COUNT(([files].[id]))":1}]`)

    const res = await fetch(`${basePath}/users/delete`, {
        method: 'POST',
        body: JSON.stringify({
            where: `id='${id}'`,
            returning: ['id', 'uid', 'name']
        }),
    })
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"id":1,"uid":"john123","name":"John Doe"}]`)

    // test cascade delete
    const res2 = await fetch(`${basePath}/files/select?select=count(id)=>ci&where=${encodeURIComponent(`user_id='${id}'`)}`)
    const json2 = (await res2.text()).trim()
    // console.log(json2)
    expect(res2.status).toEqual(200)
    expect(json2).toEqual(`[{"ci":0}]`)
})

test('delete multiple', async () => {
    const res = await fetch(`${basePath}/users/delete`, {
        method: 'POST',
        body: JSON.stringify({
            where: 'id > 7 & true',
            returning: ['id=>i', 'uid', 'name as n']
        }),
    })
    const json = (await res.text()).trim()
    expect(res.status).toEqual(200)
    expect(JSON.parse(json)).toEqual([{"i":8,"uid":"grace505","n":"Grace Lee"},{"i":9,"uid":"henry606","n":"Henry Taylor"},{"i":10,"uid":"ivy707","n":"Ivy Clark"}])

    const res1 = await fetch(`${basePath}/users/select?select=id&where=${encodeURIComponent(`id > 7`)}`)
    const json1 = (await res1.text()).trim()
    expect(res1.status).toEqual(200)
    expect(json1).toEqual(`[]`)
})

// this throws error. just use count() which is same as count(*)
test('select count(*)', async () => {
    const res = await fetch(`${basePath}/users/select?select=count(*)`)
    const json = await res.json() as any
    // console.log(json)
    expect(res.status).toEqual(400)
    expect(json.message).toEqual(`Error parsing SELECT data`)
})

test('edit(upsert update), view', async () => {
    settings.tables[0].fields[0].noInsert = false
    const res = await fetch(`${basePath}/users/edit/1?or=INSERT&returning=*`, {
        method: 'POST',
        body: JSON.stringify({
            name: 'Test Name Updated',
            email: 'test@example.com',
            uid: 'john123',
            pass_hash: 'asdjadsa'
        }),
    })
    expect(res.status).toEqual(200)
    const json = (await res.json()) as any
    const json3 = JSON.parse(JSON.stringify(json))
    delete json3.created
    delete json3.updated
    expect(json3).toEqual({
        id: 1,
        name: 'Test Name Updated',
        email: 'test@example.com',
        uid: 'john123',
        pass_hash: 'asdjadsa'
    })
    const res2 = await fetch(`${basePath}/users/view/1?select=*`)
    const json2 = await res2.json()
    // console.log(json2)
    expect(res2.status).toEqual(200)
    expect(json2).toEqual(json)
})

test('edit(upsert insert), view', async () => {
    settings.tables[0].fields[0].noInsert = false
    const res = await fetch(`${basePath}/users/edit/99?or=INSERT&returning=*`, {
        method: 'POST',
        body: JSON.stringify({
            name: 'Test Name Updated',
            email: 'test@example.com',
            uid: 'john123',
            pass_hash: 'asdjadsa'
        }),
    })
    expect(res.status).toEqual(200)
    const json = (await res.json()) as any
    const json3 = JSON.parse(JSON.stringify(json))
    delete json3.created
    delete json3.updated
    expect(json3).toEqual({
        id: 99,
        name: 'Test Name Updated',
        email: 'test@example.com',
        uid: 'john123',
        pass_hash: 'asdjadsa'
    })
    const res2 = await fetch(`${basePath}/users/view/99?select=*`)
    const json2 = await res2.json()
    // console.log(json2)
    expect(res2.status).toEqual(200)
    expect(json2).toEqual(json)
})

test('edit - invalid id should return 404', async () => {
    const res = await fetch(`${basePath}/users/edit/99999`, {
        method: 'POST',
        body: JSON.stringify({
            name: 'Test Name',
            email: 'test@example.com',
        }),
    })
    expect(res.status).toEqual(404)
    const json = await res.json()
    expect(json).toHaveProperty('code', 404)
    expect(json).toHaveProperty('message', 'Not found')
})

test('edit without returning - valid id should return 200 with empty object', async () => {
    const res = await fetch(`${basePath}/users/edit/1`, {
        method: 'POST',
        body: JSON.stringify({
            name: 'Test Name Updated',
            email: 'test@example.com',
        }),
    })
    expect(res.status).toEqual(200)
    const json = await res.json()
    expect(json).toEqual({ id: 1 }) // it should ideally be empty object, but we are getting id, thats fine for now.
})

// custom routing defined in sampleHonoApp
test('test custom routing', async () => {
    const res = await fetch(`https://localhost/teeny/test/v1/route/api/api/v1/table/users/select?select=count(id)=>count`)
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"count":10}]`)
    // console.log(JSON.parse(json))
})

// todo write versions of this with rules extension
test('procedure run query', async () => {
    const pms = []
    for (let i = 0; i < 10; i++) {
        pms.push(fetch(`https://localhost/api/v1/rpc/inc_counter_query`, {
            method: 'POST',
            body: JSON.stringify({
                file_id: 1
            })
        }))
    }
    const res = await Promise.all(pms)
    expect(res.every(r=>r.status === 200))
    const jsons = await Promise.all(res.map(r => r.json()))
    expect(jsons.length).toEqual(10)
    expect(jsons.every((j:any, i)=>j[0][0].counter === i+1)).toEqual(true)
})

// todo
// test('procedure run statement', async () => {
//     const pms = []
//     for (let i = 0; i < 10; i++) {
//         pms.push(fetch(`https://localhost/api/v1/rpc/inc_counter_statement`, {
//             method: 'POST',
//             body: JSON.stringify({
//                 file_id: 1
//             })
//         }))
//     }
//     const res = await Promise.all(pms)
//     expect(res.every(r=>r.status === 200))
//     const jsons = await Promise.all(res.map(r => r.json()))
//     expect(jsons.length).toEqual(10)
//     expect(jsons.every((j:any, i)=>j[0][0].counter === i+1)).toEqual(true)
// })

test('health endpoint', async () => {
    const res = await fetch('https://localhost/api/v1/health')
    expect(res.status).toEqual(200)
    const json = await res.json() as any
    expect(json).toHaveProperty('status', 'ok')
    expect(json).toHaveProperty('timestamp')
    expect(json).toHaveProperty('version')
    expect(typeof json.timestamp).toBe('number')
    expect(typeof json.version).toBe('number')
    expect(json.status).toBe('ok')
})
