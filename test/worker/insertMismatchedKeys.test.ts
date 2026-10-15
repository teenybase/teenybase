import {SELF} from "cloudflare:test";
import {beforeAll, expect, test} from "vitest";
import {setup} from '../data/drive2/setup'
import {DatabaseSettings} from '../../src'

// issues/resolved/insert-mismatched-keys-returns-500.md
// A multi-row insert is one INSERT with one column list. Rows that set different fields used to reach the SQL
// builder and come back as 500 "Internal server error"; now it's a 400 that names the row and the field.

const ADMIN = 'test_admin_service_token'
let base: DatabaseSettings
const insert = (values: any, token = ADMIN) => SELF.fetch('https://example.com/api/v1/table/files/insert', {
    method: 'POST',
    body: JSON.stringify({values, returning: ['name', 'tags']}),
    headers: {'$DB_TEST_DATABASE_SETTINGS': JSON.stringify(base), 'Content-Type': 'application/json', Authorization: 'Bearer ' + token},
})
const row = (name: string, extra: Record<string, any> = {}) => ({path: '/', name, ...extra})

beforeAll(async () => { base = await setup() as unknown as DatabaseSettings })

test('a row missing a field is a 400 that names it', async () => {
    const res = await insert([row('a', {tags: 'x'}), row('b')])
    expect(res.status).toEqual(400)
    expect(((await res.json()) as any).message).toEqual("Every row in values must set the same fields: row 2 is missing tags. Set the field to null in rows that don't need a value")
})

test('a row with an extra field is a 400 that names it', async () => {
    const res = await insert([row('a'), row('b'), row('c', {tags: 'x', notes: 'n'})])
    expect(res.status).toEqual(400)
    expect(((await res.json()) as any).message).toEqual("Every row in values must set the same fields: row 3 has tags, notes, which row 1 does not. Set the field to null in rows that don't need a value")
})

test('missing and extra together', async () => {
    const res = await insert([row('a', {tags: 'x'}), row('b', {notes: 'n'})])
    expect(res.status).toEqual(400)
    expect(((await res.json()) as any).message).toMatch(/row 2 is missing tags and has notes, which row 1 does not/)
})

test('the same fields in a different order insert fine (was 500)', async () => {
    const res = await insert([{path: '/', name: 'a', tags: 'x'}, {tags: 'y', name: 'b', path: '/'}])
    expect(res.status).toEqual(200)
    expect(await res.json()).toEqual([{name: 'a', tags: 'x'}, {name: 'b', tags: 'y'}])
})

test('null for the field a row does not need works', async () => {
    const res = await insert([row('a', {tags: 'x'}), row('b', {tags: null})])
    expect(res.status).toEqual(200)
    expect(await res.json()).toEqual([{name: 'a', tags: 'x'}, {name: 'b', tags: null}])
})
