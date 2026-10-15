import {SELF} from "cloudflare:test";
import {beforeAll, describe, expect, test} from "vitest";
import {setup} from '../data/drive2/setup'
import {DatabaseSettings} from '../../src'

// `new.<col>` (and, in createRule, a bare `<col>`) for a column the request leaves out.
// createRule: the value the row will get - the column default, or NULL. It used to fail with
//   `no such column: new.<col>`, so every insert that omitted the column was a 400.
// updateRule: the stored value (the column is not changing).
// drive2 files: tags has no default (NULL), notes DEFAULT '', meta DEFAULT '{}'.

let base: DatabaseSettings
const users: {id: string, token: string}[] = []

const call = (path: string, init: RequestInit, token: string | undefined, settings: DatabaseSettings) => {
    const headers: Record<string, string> = {
        '$DB_TEST_DATABASE_SETTINGS': JSON.stringify(settings),
        'Content-Type': init.method === 'POST' ? 'application/json' : 'text/plain',
    }
    if (token) headers['Authorization'] = 'Bearer ' + token
    return SELF.fetch('https://example.com/api/v1/' + path, {...init, headers})
}
const post = (body: any): RequestInit => ({method: 'POST', body: JSON.stringify(body)})
const filesRules = (rules: Record<string, string>) => {
    const s = structuredClone(base)
    const ext = s.tables.find(t => t.name === 'files')!.extensions.find(e => e.name === 'rules') as any
    Object.assign(ext, {listRule: 'created_by == auth.uid', viewRule: 'created_by == auth.uid',
        createRule: 'created_by == auth.uid', updateRule: 'created_by == auth.uid', deleteRule: 'created_by == auth.uid'}, rules)
    return s
}
let k = 0
const insert = (s: DatabaseSettings, values: Record<string, any> = {}, extra: Record<string, any> = {}) =>
    call('table/files/insert', post({values: {path: '/', name: 'f' + (++k), created_by: users[0].id, ...values}, returning: ['id', 'tags', 'notes'], ...extra}), users[0].token, s)

beforeAll(async () => {
    base = await setup() as unknown as DatabaseSettings
    // users.createRule is not under test here (it reads the omitted role too); keep the fixture independent of it
    const open = structuredClone(base)
    ;(open.tables.find(t => t.name === 'users')!.extensions.find(e => e.name === 'rules') as any).createRule = 'true'
    for (const name of ['alice', 'bob']) {
        const res = await call('table/users/auth/sign-up', post({
            username: name, email: `${name}@example.com`, password: '12345678', passwordConfirm: '12345678',
            name, meta: '{"base": "/"}',
        }), undefined, open)
        expect(res.status).toEqual(200)
        const json = await res.json() as any
        users.push({id: json.record.id, token: json.token})
    }
})

describe('createRule: an omitted column is its default, or NULL', () => {
    test('new.tags == null with tags omitted inserts (was 400 no such column: new.tags)', async () => {
        const res = await insert(filesRules({createRule: 'created_by == auth.uid & new.tags == null'}))
        expect(res.status).toEqual(200)
        expect(await res.json()).toMatchObject([{tags: null, notes: ''}])
    })

    test('a bare column name in createRule means the new row too', async () => {
        const res = await insert(filesRules({createRule: 'created_by == auth.uid & tags == null & notes == \'\''}))
        expect(res.status).toEqual(200)
        expect(await res.json()).toMatchObject([{tags: null, notes: ''}])
    })

    test('the default is what the rule sees: notes DEFAULT \'\' passes == \'\' and fails == \'x\'', async () => {
        const ok = await insert(filesRules({createRule: "created_by == auth.uid & new.notes == ''"}))
        expect(ok.status).toEqual(200)
        expect(await ok.json()).toHaveLength(1)
        const denied = await insert(filesRules({createRule: "created_by == auth.uid & new.notes == 'x'"}))
        expect(denied.status).toEqual(200)
        expect(await denied.json()).toEqual([])
    })

    test('a JSON object default compares as its stored text', async () => {
        const res = await insert(filesRules({createRule: "created_by == auth.uid & new.meta == '{}'"}))
        expect(res.status).toEqual(200)
        expect(await res.json()).toHaveLength(1)
    })

    test('a column the request does send still reads the sent value', async () => {
        const s = filesRules({createRule: "created_by == auth.uid & new.tags == 'a'"})
        const ok = await insert(s, {tags: 'a'})
        expect(await ok.json()).toMatchObject([{tags: 'a'}])
        const denied = await insert(s, {tags: 'b'})
        expect(denied.status).toEqual(200)
        expect(await denied.json()).toEqual([])
    })

    test('multi-row insert with the column omitted in every row', async () => {
        const res = await call('table/files/insert', post({values: [
            {path: '/', name: 'm1', created_by: users[0].id},
            {path: '/', name: 'm2', created_by: users[0].id},
        ], returning: ['name', 'tags']}), users[0].token, filesRules({createRule: 'created_by == auth.uid & new.tags == null'}))
        expect(res.status).toEqual(200)
        expect(await res.json()).toEqual([{name: 'm1', tags: null}, {name: 'm2', tags: null}])
    })

    test('or: IGNORE and /edit?or=INSERT go through the same path', async () => {
        const s = filesRules({createRule: 'created_by == auth.uid & new.tags == null', deleteRule: 'true'})
        const ign = await insert(s, {}, {or: 'IGNORE'})
        expect(ign.status).toEqual(200)
        expect(await ign.json()).toHaveLength(1)
        const edit = await call('table/files/edit/edit-insert-1?or=INSERT&returning=id,tags', post({
            path: '/', name: 'e', created_by: users[0].id,
        }), users[0].token, s)
        expect(edit.status).toEqual(200)
        expect(await edit.json()).toEqual({id: 'edit-insert-1', tags: null})
    })
})

describe('updateRule: an omitted new.<col> is the stored value', () => {
    // the README blog-post pattern: the author may edit the post but not hand it to someone else
    const s = () => filesRules({updateRule: 'created_by == auth.uid & new.created_by == created_by & new.tags == tags'})

    test('an unrelated update passes (created_by and tags are not in the request; tags is NULL)', async () => {
        const id = ((await (await insert(base)).json()) as any)[0].id
        const res = await call('table/files/update', post({where: `id == '${id}'`, setValues: {name: 'renamed'}, returning: ['id', 'name', 'created_by']}), users[0].token, s())
        expect(res.status).toEqual(200)
        expect(await res.json()).toEqual([{id, name: 'renamed', created_by: users[0].id}])
    })

    test('changing the guarded column is blocked', async () => {
        const id = ((await (await insert(base)).json()) as any)[0].id
        const res = await call('table/files/update', post({where: `id == '${id}'`, setValues: {created_by: users[1].id}, returning: ['id']}), users[0].token, s())
        expect(res.status).toEqual(200)
        expect(await res.json()).toEqual([])
        const res2 = await call('table/files/update', post({where: `id == '${id}'`, setValues: {tags: 'x'}, returning: ['id']}), users[0].token, s())
        expect(await res2.json()).toEqual([])
    })

    test('single = keeps SQL NULL semantics: new.tags = tags on a NULL tags never matches (use ==)', async () => {
        const id = ((await (await insert(base)).json()) as any)[0].id
        const res = await call('table/files/update', post({where: `id == '${id}'`, setValues: {name: 'x'}, returning: ['id']}), users[0].token,
            filesRules({updateRule: 'created_by == auth.uid & new.tags = tags'}))
        expect(res.status).toEqual(200)
        expect(await res.json()).toEqual([])
    })
})
