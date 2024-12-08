import {SELF} from "cloudflare:test";
import {beforeAll, expect, test} from "vitest";
import {setup} from '../data/test1/setup'
import {DatabaseSettings, TableRulesExtensionData} from '../../src'

let settings: DatabaseSettings
beforeAll(async () => {
    settings = await setup()
    settings.tables[0].extensions[0] = {
        name: "rules",
        listRule: 'users.id>2 & request.url.href~"https://localhost%" & id < 8 | id > 10', // id is same as user.id
        viewRule: 'true',
        createRule: 'uid ~ "test%"', // uid starts with test
        updateRule: 'users.id>2 & id < 8 & new.name ~ "%.0"', // can only update if name endsWith .0
        deleteRule: 'users.id>2 & id < 7',
    } as TableRulesExtensionData

    settings.tables[1].extensions[0] = {
        name: "rules",
        listRule: 'length(name)>10',
        viewRule: 'true',
        createRule: 'true',
        updateRule: 'true',
        deleteRule: 'true',
    } as TableRulesExtensionData

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
    const res = await fetch(`https://localhost/api/v1/table/users/select?limit=4&select=id,name,email&order=uid&where=${encodeURIComponent(`name~'%o%'`)}`)
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"id":4,"name":"Alice Brown","email":"alice@example.com"},{"id":3,"name":"Bob Johnson","email":"bob@example.com"},{"id":6,"name":"Eva Wilson","email":"eva@example.com"}]`)
    // console.log(JSON.parse(json))
})

test('select with filters get 2', async () => {
    const res = await fetch(`https://localhost/api/v1/table/users/select?select=uid,users.id&order=name&where=${encodeURIComponent(`name~'%o%'&id>5`)}`)
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"uid":"eva303","id":6}]`)
    // console.log(JSON.parse(json))
})

test('rules bypass test', async () => {
    const res = await fetch(`https://localhost/api/v1/table/users/select?select=users.id&order=id&where=${encodeURIComponent(`(1=1)|(2=2)`)}`, {headers: {
            $DB_TEST_AUTO_SIMPLIFY_EXPR: 'false',
        }})
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"id":3},{"id":4},{"id":5},{"id":6},{"id":7}]`)
})

test('select count all', async () => {
    const res = await fetch(`https://localhost/api/v1/table/users/select?select=count()`)
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"COUNT(*)":5}]`)
    // console.log(JSON.parse(json))
})

// test('select with join', async () => {
//     const res = await fetch(`https://localhost/api/v1/table/users/select?select=users.uid,files.id&join=files.user_id=users.id&where=${encodeURIComponent(`users.id=1`)}`)
//     const json = (await res.text()).trim()
// //     console.log(json)
//     expect(res.status).toEqual(200)
//     expect(json).toEqual(`[{"uid":"john123","id":1}]`)
// //     console.log(JSON.parse(json))
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
    expect(json).toEqual(`[{"uid":"alice101","name":"Alice Brown","email":"alice@example.com"},{"uid":"bob789","name":"Bob Johnson","email":"bob@example.com"},{"uid":"eva303","name":"Eva Wilson","email":"eva@example.com"}]`)
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

test('update single setValues should not add', async () => {
    const res = await fetch(`https://localhost/api/v1/table/users/update`, {
        method: 'POST',
        body: JSON.stringify({
            setValues: {
                name: 'Test Name Updated.0',
                email: 'test@example.com',
            },
            where: `uid='john123'`,
            returning: ['id', 'uid', 'name', 'email']
        }),
    })
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[]`)
    const res2 = await fetch(`https://localhost/api/v1/table/users/select?select=id,uid,name,email&where=${encodeURIComponent(`email="test@example.com"`)}`)
    const json2 = (await res2.text()).trim()
    // console.log(json2)
    expect(res2.status).toEqual(200)
    expect(json2).toEqual('[]')
})

test('update single setValues', async () => {
    const res = await fetch(`https://localhost/api/v1/table/users/update`, {
        method: 'POST',
        body: JSON.stringify({
            setValues: {
                name: 'Test Name Updated.0',
                email: 'test@example.com',
            },
            where: `uid='alice101'`,
            returning: ['id', 'uid', 'name', 'email']
        }),
    })
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"id":4,"uid":"alice101","name":"Test Name Updated.0","email":"test@example.com"}]`)
    const js = JSON.parse(json)[0]
    const res2 = await fetch(`https://localhost/api/v1/table/users/select?select=id,uid,name,email&where=${encodeURIComponent(`id=`+js.id)}`)
    const json2 = (await res2.text()).trim()
    // console.log(json2)
    expect(res2.status).toEqual(200)
    expect(json2).toEqual(json)
})

test('update single setValues fail', async () => {
    const res = await fetch(`https://localhost/api/v1/table/users/update`, {
        method: 'POST',
        body: JSON.stringify({
            setValues: {
                name: 'Test Name Updated', // fail because name doesn't ends with `.0` as specified in the rule
                email: 'test@example.com',
            },
            where: `uid='alice101'`,
            returning: ['id', 'uid', 'name', 'email']
        }),
    })
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[]`)
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
    expect(json).toEqual(`[]`) // fail check

    const res1 = await fetch(`https://localhost/api/v1/table/users/update`, {
        method: 'POST',
        body: JSON.stringify({
            set: {
                name: 'concat(name,"1") || 100',
                email: '"test@example.com"',
            },
            where: `uid='alice101' & name='Alice Brown'`,
            returning: ['id', 'uid', 'name']
        }),
    })
    const json1 = (await res1.text()).trim()
    // console.log(json1)
    expect(res1.status).toEqual(200)
    expect(json1).toEqual(`[{"id":4,"uid":"alice101","name":"Alice Brown1100.0"}]`)

    const js = JSON.parse(json1)[0]
    const res2 = await fetch(`https://localhost/api/v1/table/users/select?select=id,uid,name&where=${encodeURIComponent(`name="${js.name}"`)}`)
    const json2 = (await res2.text()).trim()
    // console.log(json2)
    expect(res2.status).toEqual(200)
    expect(json2).toEqual(json1)
})

test('update multiple set', async () => {
    const res = await fetch(`https://localhost/api/v1/table/users/update`, {
        method: 'POST',
        body: JSON.stringify({
            set: {
                name: 'concat(name,"1") || 100.', // || is also concat
            },
            where: 'id > 0 & new.name!~"%101%"',
            returning: '*',
        }),
    })
    const json = (await res.text()).trim()
    expect(res.status).toEqual(200)
    const data = JSON.parse(json)
    expect(data.length).toEqual(5) // without the rule it should be 10
    Object.values(data).forEach((d: any) => {
        delete d.created;
        delete d.updated;
        delete d.email;
        delete d.pass_hash;
    })
    // console.log(JSON.stringify(data))
    expect(JSON.stringify(data)).toEqual(`[{"id":3,"name":"Bob Johnson1100.0","uid":"bob789"},{"id":4,"name":"Alice Brown1100.0","uid":"alice101"},{"id":5,"name":"Charlie Davis1100.0","uid":"charlie202"},{"id":6,"name":"Eva Wilson1100.0","uid":"eva303"},{"id":7,"name":"Frank Miller1100.0","uid":"frank404"}]`)
})

test('delete single', async () => {
    const id = '5'
    const res1 = await fetch(`https://localhost/api/v1/table/files/select?select=count(id)&where=${encodeURIComponent(`user_id>${id}`)}`)
    const json1 = (await res1.text()).trim()
    // console.log(json1)
    expect(res1.status).toEqual(200)
    expect(json1).toEqual(`[{"COUNT(([files].[id]))":2}]`)

    const res = await fetch(`https://localhost/api/v1/table/users/delete`, {
        method: 'POST',
        body: JSON.stringify({
            where: `id>${id}`,
            returning: ['id', 'uid', 'name']
        }),
    })
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"id":6,"uid":"eva303","name":"Eva Wilson"}]`)

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
            where: 'true',
            returning: ['id', 'uid']
        }),
    })
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"id":3,"uid":"bob789"},{"id":4,"uid":"alice101"},{"id":5,"uid":"charlie202"},{"id":6,"uid":"eva303"}]`)

    const res1 = await fetch(`https://localhost/api/v1/table/users/select?select=id&where=${encodeURIComponent(`id > 0`)}`)
    const json1 = (await res1.text()).trim()
    // console.log(json1)
    expect(res1.status).toEqual(200)
    expect(json1).toEqual(`[{"id":7}]`)
})

test('select count id', async () => {
    const res = await fetch(`https://localhost/api/v1/table/users/select?select=count(id)=>count`)
    const json = (await res.text()).trim()
    // console.log(json)
    expect(res.status).toEqual(200)
    expect(json).toEqual(`[{"count":5}]`)
    // console.log(JSON.parse(json))
})

// todo make tests for sub query rule enforement using foriegn key expand and fts
