import {env} from 'cloudflare:test'
import {describe, expect, it} from 'vitest'
import {$DatabaseRawImpl} from '../../src/worker/$DatabaseRawImpl'
import {PreparedQuery, type QueryResult, type StorageAdapter} from '../../src/worker/storage/StorageAdapter'

// Regression suite for batched queries failing at a storage RPC boundary.
//
// A storage adapter does not have to be in-process: it can be a Workers RPC stub to a
// WorkerEntrypoint in another worker that implements `run` / `runBatch`. `_execBatch` collected
// its statements into `PreparedQuery` instances (a real class, frozen) and passed the array
// straight to `adapter.runBatch()`. `StorageAdapter.runBatch` is typed as the plain `{q, v}[]`
// shape and `PreparedQuery` is structurally compatible, so TypeScript never complained; but
// workerd's RPC serializer refuses application-defined class instances, so every batch over the
// stub died with `Could not serialize object of type "PreparedQuery"`. Single-statement reads use
// `adapter.run(q, v)` and were unaffected, which is why `.select()` worked while `.list()` (it adds
// a COUNT statement), `.insert()` and `.update()` failed.
//
// The other suites run against a real D1 binding, where the adapter is in-process and passing class
// instances is harmless. Here `env.RECORDING_DB` is a service binding to `RecordingDbRpc` in
// rpcRecorderWorker.js, so the boundary is actually crossed.

type Recorded = {q: string, v: unknown[], plainArray?: boolean}

function rpcAdapter(): StorageAdapter {
    return env.RECORDING_DB as unknown as StorageAdapter
}

describe('storage adapter over a Workers RPC boundary', () => {
    it('sends a batch across the stub without a serialization failure', async () => {
        const db = new $DatabaseRawImpl(rpcAdapter())

        // Before the fix this rejected with `Could not serialize object of type "PreparedQuery"`.
        const res = await db.rawSQLTransaction<Recorded>([
            {q: 'SELECT * FROM users LIMIT ?', v: [50]},
            {q: 'SELECT COUNT(*) AS total FROM users', v: []},
        ]).run()

        // and the far side received both statements intact, in order
        expect(res).toHaveLength(2)
        expect(res![0][0]).toEqual({q: 'SELECT * FROM users LIMIT ?', v: [50], plainArray: true})
        expect(res![1][0]).toEqual({q: 'SELECT COUNT(*) AS total FROM users', v: [], plainArray: true})
    })

    it('sends bind values of every JSON type a column can hold', async () => {
        const db = new $DatabaseRawImpl(rpcAdapter())

        const res = await db.rawSQLTransaction<Recorded>([
            {q: 'INSERT INTO t VALUES (?, ?, ?, ?, ?)', v: ['text', 42, null, 1, 1.5]},
        ]).run()

        expect(res![0][0].v).toEqual(['text', 42, null, 1, 1.5])
    })

    it('still sends a single statement across the stub', async () => {
        // The unbatched path was always fine; pinned so a change to the batch path cannot break it.
        const db = new $DatabaseRawImpl(rpcAdapter())

        const res = await db.rawSQL<Recorded>({q: 'SELECT ?', v: [1]}).run()

        expect(res![0]).toEqual({q: 'SELECT ?', v: [1]})
    })

    it('a raw PreparedQuery is what the RPC boundary rejects', async () => {
        // Characterises the platform constraint the flattening exists for, so that if a future
        // workerd starts accepting class instances the reason for the mapping is still on record.
        const stub = rpcAdapter() as unknown as {runBatch(q: unknown[]): Promise<unknown>}

        await expect(stub.runBatch([new PreparedQuery('SELECT 1', [])])).rejects.toThrow(/serialize/i)
    })

    it('hands an in-process adapter plain objects with plain, unfrozen arrays', async () => {
        const received: unknown[] = []
        const adapter: StorageAdapter = {
            async run<T>(): Promise<QueryResult<T>> {
                return {success: true, results: [], meta: {}} as unknown as QueryResult<T>
            },
            async runBatch<T>(queries: {q: string, v: readonly unknown[]}[]): Promise<QueryResult<T>[]> {
                received.push(...queries)
                return queries.map(() => ({success: true, results: [], meta: {}}) as unknown as QueryResult<T>)
            },
        }
        const db = new $DatabaseRawImpl(adapter)

        await db.rawSQLTransaction([{q: 'SELECT ?', v: ['a']}, {q: 'SELECT 2', v: []}]).run()

        expect(received).toHaveLength(2)
        for (const query of received as {q: string, v: unknown[]}[]) {
            expect(Object.getPrototypeOf(query)).toBe(Object.prototype)
            expect(Object.keys(query).sort()).toEqual(['q', 'v'])
            expect(Array.isArray(query.v)).toBe(true)
            expect(Object.isFrozen(query.v)).toBe(false)
        }
        expect(received).toEqual([{q: 'SELECT ?', v: ['a']}, {q: 'SELECT 2', v: []}])
    })
})
