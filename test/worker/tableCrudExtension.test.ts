import {SELF} from "cloudflare:test";
import {beforeAll, expect, test} from "vitest";
import {DatabaseSettings} from '../../src'
import {setup} from '../data/test1/setup'

let settings: DatabaseSettings
beforeAll(async () => {
    settings = await setup()
    console.log('Before All - Setup Test 1')
})

const fetch = (input: RequestInfo, init?: RequestInit)=>SELF.fetch(input, {...init, ...{
        headers: {
            ...init?.headers,
            '$DB_TEST_DATABASE_SETTINGS': JSON.stringify(settings),
            'Content-Type': init?.method === 'POST' ? 'application/json' : 'text/plain',
        }
    }})

test('select with filters get', async () => {
    const res = await fetch(`https://localhost/api/v1/table/users/select?limit=4&select=uid,name,email&order=uid&where=${encodeURIComponent(`name~'%o%'`)}`)
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"uid":"alice101","name":"Alice Brown","email":"alice@example.com"},{"uid":"bob789","name":"Bob Johnson","email":"bob@example.com"},{"uid":"eva303","name":"Eva Wilson","email":"eva@example.com"},{"uid":"henry606","name":"Henry Taylor","email":"henry@example.com"}]`)
    // console.log(JSON.parse(json))
})


test('select with filters get 2', async () => {
    const res = await fetch(`https://localhost/api/v1/table/users/select?select=uid,users.id&order=name&where=${encodeURIComponent(`name~'%o%'&id>5`)}`)
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"uid":"eva303","id":6},{"uid":"henry606","id":9}]`)
    // console.log(JSON.parse(json))
})

test('select count id', async () => {
    const res = await fetch(`https://localhost/api/v1/table/users/select?select=count(id)=>count`)
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"count":10}]`)
    // console.log(JSON.parse(json))
})

test('select count all', async () => {
    const res = await fetch(`https://localhost/api/v1/table/users/select?select=count()`)
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"COUNT(*)":10}]`)
    // console.log(JSON.parse(json))
})

// test('select with join', async () => {
//     const res = await fetch(`https://localhost/api/v1/table/users/select?select=users.uid,files.id&join=files.user_id=users.id&where=${encodeURIComponent(`users.id=1`)}`)
//     const json = (await res.text()).trim()
//     console.log(json)
//     expect(res.status).toEqual(200)
//     expect(json).toEqual(`[{"uid":"john123","id":1}]`)
//     console.log(JSON.parse(json))
// })

test('select with filters post', async () => {
    const res = await fetch(`https://localhost/api/v1/table/users/select`, {
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
    const res = await fetch(`https://localhost/api/v1/table/users/insert`, {
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
    const res2 = await fetch(`https://localhost/api/v1/table/users/select?select=id,uid,name,email&where=${encodeURIComponent(`id=`+js.id)}`)
    const json2 = (await res2.text()).trim()
    // console.log(json2)
    expect(res2.status).toEqual(200)
    expect(json2).toEqual(json)
})

test('insert multiple', async () => {
    const time = Date.now() / 1000
    await new Promise((r) => setTimeout(r, 1000))
    const res = await fetch(`https://localhost/api/v1/table/users/insert`, {
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
    const res2 = await fetch(`https://localhost/api/v1/table/users/select?select=id,pass_hash&where=${encodeURIComponent(`unixepoch(created)>=${time}`)}`)
    const json2 = (await res2.text()).trim()
    // console.log(JSON.parse(json2))
    expect(res2.status).toEqual(200)
    expect(json2).toEqual(json)
})

test('update single setValues', async () => {
    const res = await fetch(`https://localhost/api/v1/table/users/update`, {
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
    const res2 = await fetch(`https://localhost/api/v1/table/users/select?select=id,uid,name,email&where=${encodeURIComponent(`id=`+js.id)}`)
    const json2 = (await res2.text()).trim()
    // console.log(json2)
    expect(res2.status).toEqual(200)
    expect(json2).toEqual(json)
})


test('update single set', async () => {
    const res = await fetch(`https://localhost/api/v1/table/users/update`, {
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
    const res2 = await fetch(`https://localhost/api/v1/table/users/select?select=id,uid,name&where=${encodeURIComponent(`name="${js.name}"`)}`)
    const json2 = (await res2.text()).trim()
    // console.log(json2)
    expect(res2.status).toEqual(200)
    expect(json2).toEqual(json)
})

test('update multiple set', async () => {
    const res = await fetch(`https://localhost/api/v1/table/users/update`, {
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
    const res1 = await fetch(`https://localhost/api/v1/table/files/select?select=count(id)&where=${encodeURIComponent(`user_id='${id}'`)}`)
    const json1 = (await res1.text()).trim()
    // console.log(json1)
    expect(res1.status).toEqual(200)
    expect(json1).toEqual(`[{"COUNT(([files].[id]))":1}]`)

    const res = await fetch(`https://localhost/api/v1/table/users/delete`, {
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
    const res2 = await fetch(`https://localhost/api/v1/table/files/select?select=count(id)=>ci&where=${encodeURIComponent(`user_id='${id}'`)}`)
    const json2 = (await res2.text()).trim()
    // console.log(json2)
    expect(res2.status).toEqual(200)
    expect(json2).toEqual(`[{"ci":0}]`)
})

test('delete multiple', async () => {
    const res = await fetch(`https://localhost/api/v1/table/users/delete`, {
        method: 'POST',
        body: JSON.stringify({
            where: 'id > 7 & true',
            returning: ['id=>i', 'uid', 'name as n']
        }),
    })
    const json = (await res.text()).trim()
    expect(res.status).toEqual(200)
    expect(JSON.parse(json)).toEqual([{"i":8,"uid":"grace505","n":"Grace Lee"},{"i":9,"uid":"henry606","n":"Henry Taylor"},{"i":10,"uid":"ivy707","n":"Ivy Clark"}])

    const res1 = await fetch(`https://localhost/api/v1/table/users/select?select=id&where=${encodeURIComponent(`id > 7`)}`)
    const json1 = (await res1.text()).trim()
    expect(res1.status).toEqual(200)
    expect(json1).toEqual(`[]`)
})

// this throws error. just use count() which is same as count(*)
test('select count(*)', async () => {
    const res = await fetch(`https://localhost/api/v1/table/users/select?select=count(*)`)
    const json = await res.json() as any
    // console.log(json)
    expect(res.status).toEqual(400)
    expect(json.message).toEqual(`Error parsing SELECT data`)
})

