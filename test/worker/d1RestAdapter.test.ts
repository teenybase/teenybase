import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'
import {D1RestAdapter} from '../../src/worker/storage/D1RestAdapter'

const OK_RESP = (results: any[], meta: any = {}) => ({
    success: true, errors: [], messages: [],
    result: [{success: true, meta: {duration: 1, rows_read: 0, rows_written: 0, ...meta}, results}],
})

describe('D1RestAdapter.run', () => {
    let fetchMock: any
    beforeEach(() => {
        fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
    })
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

    it('POSTs to the correct URL with auth header and body', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(OK_RESP([{a: 1}])), {status: 200}))
        const a = new D1RestAdapter({accountId: 'ACC', databaseId: 'DB', apiToken: 'TOK'})
        const r = await a.run<{a: number}>('SELECT a FROM t WHERE a = ?', [1])
        expect(fetchMock).toHaveBeenCalledOnce()
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/ACC/d1/database/DB/query')
        expect(init.method).toBe('POST')
        expect(init.headers['Authorization']).toBe('Bearer TOK')
        expect(init.headers['Content-Type']).toBe('application/json')
        expect(JSON.parse(init.body)).toEqual({sql: 'SELECT a FROM t WHERE a = ?', params: [1]})
        expect(r.success).toBe(true)
        expect(r.results).toEqual([{a: 1}])
    })

    it('coerces boolean bind values to 1/0', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(OK_RESP([])), {status: 200}))
        const a = new D1RestAdapter({accountId: 'A', databaseId: 'B', apiToken: 'T'})
        await a.run('SELECT 1', [true, false])
        const body = JSON.parse(fetchMock.mock.calls[0][1].body)
        expect(body.params).toEqual([1, 0])
    })

    it('passes through null and string/number values', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(OK_RESP([])), {status: 200}))
        const a = new D1RestAdapter({accountId: 'A', databaseId: 'B', apiToken: 'T'})
        await a.run('x', [null, 'hi', 42])
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).params).toEqual([null, 'hi', 42])
    })

    it('throws on HTTP 401 (transport error)', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            success: false, errors: [{code: 10000, message: 'Unauthorized'}], messages: [], result: null,
        }), {status: 401}))
        const a = new D1RestAdapter({accountId: 'A', databaseId: 'B', apiToken: 'T'})
        await expect(a.run('SELECT 1', [])).rejects.toThrow(/401|Unauthorized/)
    })

    it('throws on top-level {success:false} with the first error message', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            success: false, errors: [{code: 7003, message: 'bad route'}], messages: [], result: null,
        }), {status: 200}))
        const a = new D1RestAdapter({accountId: 'A', databaseId: 'B', apiToken: 'T'})
        await expect(a.run('SELECT 1', [])).rejects.toThrow(/bad route/)
    })

    it('throws on per-statement failure inside result array', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            success: true, errors: [], messages: [],
            result: [{success: false, meta: {}, results: [], error: 'UNIQUE constraint failed'}],
        }), {status: 200}))
        const a = new D1RestAdapter({accountId: 'A', databaseId: 'B', apiToken: 'T'})
        await expect(a.run('INSERT INTO t VALUES (1)', [])).rejects.toThrow(/UNIQUE constraint/)
    })

    it('throws for unsupported bind types (Date, BigInt, plain object)', async () => {
        const a = new D1RestAdapter({accountId: 'A', databaseId: 'B', apiToken: 'T'})
        await expect(a.run('x', [new Date() as any])).rejects.toThrow()
        await expect(a.run('x', [1n as any])).rejects.toThrow()
        await expect(a.run('x', [{foo: 'bar'} as any])).rejects.toThrow()
    })
})

describe('D1RestAdapter.runBatch', () => {
    let fetchMock: any
    beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

    it('sends documented batch body and returns one QueryResult per statement', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            success: true, errors: [], messages: [],
            result: [
                {success: true, meta: {rows_read: 1}, results: [{a: 1}]},
                {success: true, meta: {rows_written: 1}, results: []},
            ],
        }), {status: 200}))
        const a = new D1RestAdapter({accountId: 'A', databaseId: 'B', apiToken: 'T'})
        const r = await a.runBatch<any>([
            {q: 'SELECT a FROM t', v: []},
            {q: 'INSERT INTO t VALUES (?)', v: [1]},
        ])
        const body = JSON.parse(fetchMock.mock.calls[0][1].body)
        expect(body).toEqual({
            batch: [
                {sql: 'SELECT a FROM t', params: []},
                {sql: 'INSERT INTO t VALUES (?)', params: [1]},
            ],
        })
        expect(r).toHaveLength(2)
        expect(r[0].results).toEqual([{a: 1}])
    })

    it('returns empty array for empty input without calling fetch', async () => {
        const a = new D1RestAdapter({accountId: 'A', databaseId: 'B', apiToken: 'T'})
        const r = await a.runBatch([])
        expect(r).toEqual([])
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('throws with statement index on mid-batch failure (atomic semantics)', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            success: true, errors: [], messages: [],
            result: [
                {success: true, meta: {}, results: []},
                {success: false, meta: {}, results: [], error: 'FOREIGN KEY constraint failed'},
            ],
        }), {status: 200}))
        const a = new D1RestAdapter({accountId: 'A', databaseId: 'B', apiToken: 'T'})
        await expect(a.runBatch([
            {q: 'INSERT INTO t VALUES (1)', v: []},
            {q: 'INSERT INTO u VALUES (99)', v: []},
        ])).rejects.toThrow(/batch\[1\].*FOREIGN KEY/)
    })
})
