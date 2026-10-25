import {SELF} from 'cloudflare:test'
import {beforeAll, expect, test} from 'vitest'
import {setup} from '../data/drive2/setup'
import {DatabaseSettings} from '../../src'

// A `where` with non-Latin text in a string literal used to be rejected by sqlExprSchema's ASCII-only
// allowlist (400 "Invalid expression") before it reached the parser. End to end through D1: the
// filter is accepted, the literal is bound as a parameter, and it matches the stored row.

const ADMIN = 'test_admin_service_token'
let settings: DatabaseSettings
beforeAll(async () => { settings = await setup() as unknown as DatabaseSettings })

const call = (path: string, body: unknown) => SELF.fetch('https://example.com/api/v1/table/files/' + path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {'$DB_TEST_DATABASE_SETTINGS': JSON.stringify(settings), 'Content-Type': 'application/json', Authorization: 'Bearer ' + ADMIN},
})

const names = ['文件（一）.glb', 'પ્રથમ-bwr97p.glb', 'メモ、テスト。.glb', 'ملف.glb', 'file😀.glb']

test('filters on non-Latin, CJK-punctuation and emoji string literals', async () => {
    const ins = await call('insert', {values: names.map((name, i) => ({path: '/u/', name, tags: 't' + i})), returning: ['name']})
    expect(ins.status).toBe(200)

    for (const name of names) {
        const res = await call('select', {where: `path = '/u/' & name = ${JSON.stringify(name)}`, select: 'name'})
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual([{name}])
    }

    const like = await call('select', {where: `name ~ '%（一）%'`, select: 'name'})
    expect(like.status).toBe(200)
    expect(await like.json()).toEqual([{name: '文件（一）.glb'}])
})

test('control characters are still rejected', async () => {
    const res = await call('select', {where: `name = "a\u0007b"`, select: 'name'})
    expect(res.status).toBe(400)
})
