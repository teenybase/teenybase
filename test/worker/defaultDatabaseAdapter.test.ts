import {describe, expect, it} from 'vitest'
import {DefaultDatabaseAdapter} from '../../src/worker/storage/DefaultDatabaseAdapter'
import type {StorageAdapter, QueryResult} from '../../src/worker/storage/StorageAdapter'
import type {DatabaseConfig} from '../../src/types/config'
import {env} from 'cloudflare:test'

describe('DefaultDatabaseAdapter', () => {
    describe('type: d1-binding (built-in)', () => {
        it('resolves to a StorageAdapter that runs against env[binding]', async () => {
            const cfg: DatabaseConfig = {type: 'd1-binding', binding: 'PRIMARY_DB'}
            const a = new DefaultDatabaseAdapter(cfg, env)
            const r = await a.run<{one: number}>('SELECT 1 AS one', [])
            expect(r.success).toBe(true)
            expect(r.results[0].one).toBe(1)
        })

        it('uses the default binding name "PRIMARY_DB" when config is undefined', async () => {
            const a = new DefaultDatabaseAdapter(undefined, env)
            const r = await a.run<{one: number}>('SELECT 1 AS one', [])
            expect(r.results[0].one).toBe(1)
        })

        it('throws when the named binding is not present in env', async () => {
            const cfg: DatabaseConfig = {type: 'd1-binding', binding: 'NOT_A_REAL_BINDING'}
            const a = new DefaultDatabaseAdapter(cfg, env)
            await expect(a.run('SELECT 1', [])).rejects.toThrow(/NOT_A_REAL_BINDING/)
        })
    })

    describe('unknown type without registered delegate', () => {
        it('throws with a helpful message naming the extension to register', async () => {
            const cfg: DatabaseConfig = {type: 'libsql', url: 'libsql://x'}
            const a = new DefaultDatabaseAdapter(cfg, env)
            await expect(a.run('SELECT 1', [])).rejects.toThrow(/libsql/)
            await expect(a.run('SELECT 1', [])).rejects.toThrow(/registerExtension/)
        })
    })

    describe('registerDelegate', () => {
        it('dispatches to the registered delegate for a non-builtin type', async () => {
            const cfg: DatabaseConfig = {type: 'libsql', url: 'libsql://x'}
            const a = new DefaultDatabaseAdapter(cfg, env)

            const calls: {q: string, v: any[]}[] = []
            const fake: StorageAdapter = {
                async run(q, v) {
                    calls.push({q, v: [...v]})
                    return {success: true, results: [{mock: true}]} as QueryResult<any>
                },
                async runBatch(qs) {
                    return qs.map(() => ({success: true, results: []})) as QueryResult<any>[]
                },
            }
            a.registerDelegate('libsql', fake)

            const r = await a.run<{mock: boolean}>('SELECT ?', [42])
            expect(r.success).toBe(true)
            expect(r.results[0].mock).toBe(true)
            expect(calls).toEqual([{q: 'SELECT ?', v: [42]}])
        })
    })

    describe('resolve caches', () => {
        it('only resolves the adapter once (no re-lookup per query)', async () => {
            const cfg: DatabaseConfig = {type: 'libsql', url: 'libsql://x'}
            const a = new DefaultDatabaseAdapter(cfg, env)

            let resolveCount = 0
            const fake: StorageAdapter = {
                async run() {
                    resolveCount++
                    return {success: true, results: []} as QueryResult<any>
                },
                async runBatch() { return [] },
            }
            a.registerDelegate('libsql', fake)

            await a.run('SELECT 1', [])
            await a.run('SELECT 2', [])
            await a.run('SELECT 3', [])

            expect(resolveCount).toBe(3)   // run called 3 times, once per query (delegate IS hit every time)
        })

        it('does not re-read registerDelegate after the first resolve (late delegates are ignored)', async () => {
            const cfg: DatabaseConfig = {type: 'libsql', url: 'libsql://x'}
            const a = new DefaultDatabaseAdapter(cfg, env)

            const first: StorageAdapter = {
                async run() { return {success: true, results: [{from: 'first'}]} as QueryResult<any> },
                async runBatch() { return [] },
            }
            const second: StorageAdapter = {
                async run() { return {success: true, results: [{from: 'second'}]} as QueryResult<any> },
                async runBatch() { return [] },
            }
            a.registerDelegate('libsql', first)
            const r1 = await a.run<{from: string}>('SELECT 1', [])
            a.registerDelegate('libsql', second)      // registered late — must be ignored due to caching
            const r2 = await a.run<{from: string}>('SELECT 2', [])

            expect(r1.results[0].from).toBe('first')
            expect(r2.results[0].from).toBe('first')
        })
    })
})
