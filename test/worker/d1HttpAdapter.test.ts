import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'
import {D1HttpAdapter} from '../../src/worker/storage/D1HttpAdapter'

const OK = (results: any[], meta: any = {}) => ({
    results, success: true,
    meta: {duration: 0.1, changes: 0, last_row_id: 0, changed_db: false, size_after: 0,
           rows_read: 0, rows_written: 0, served_by: 'self-hosted', served_by_region: 'local', served_by_primary_region: 'local',
           ...meta},
})

describe('D1HttpAdapter.run', () => {
    let fetchMock: any
    beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

    it('POSTs to /query/all/ with auth header and encoded params', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(OK([{a: 1}])), {status: 200}))
        const a = new D1HttpAdapter({url: 'https://db.example.com', authToken: 'TOK'})
        const r = await a.run<{a: number}>('SELECT a FROM t WHERE a = ?', [1])

        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('https://db.example.com/query/all/')
        expect(init.method).toBe('POST')
        expect(init.headers['Authorization']).toBe('Bearer TOK')
        expect(init.headers['Content-Type']).toBe('application/json')
        expect(JSON.parse(init.body)).toEqual({sql: 'SELECT a FROM t WHERE a = ?', params: [1]})

        expect(r.success).toBe(true)
        expect(r.results).toEqual([{a: 1}])
    })

    it('strips trailing slash from base URL', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(OK([])), {status: 200}))
        const a = new D1HttpAdapter({url: 'https://db.example.com/', authToken: 't'})
        await a.run('SELECT 1', [])
        expect(fetchMock.mock.calls[0][0]).toBe('https://db.example.com/query/all/')
    })

    it('encodes bigint as {__bigint} sentinel', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(OK([])), {status: 200}))
        const a = new D1HttpAdapter({url: 'https://x', authToken: 't'})
        await a.run('x', [12345678901234567890n])
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).params).toEqual([{__bigint: '12345678901234567890'}])
    })

    it('encodes Uint8Array / ArrayBuffer as {__blob} base64', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(OK([])), {status: 200}))
        const a = new D1HttpAdapter({url: 'https://x', authToken: 't'})
        await a.run('x', [new Uint8Array([1, 2, 3]), new Uint8Array([255]).buffer])
        const params = JSON.parse(fetchMock.mock.calls[0][1].body).params
        expect(params[0]).toEqual({__blob: 'AQID'})
        expect(params[1]).toEqual({__blob: '/w=='})
    })

    it('encodes boolean to 1|0, Date to ISO, null/undefined to null', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(OK([])), {status: 200}))
        const a = new D1HttpAdapter({url: 'https://x', authToken: 't'})
        const dt = new Date('2026-04-21T10:00:00.000Z')
        await a.run('x', [true, false, dt, null, undefined])
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).params).toEqual([1, 0, '2026-04-21T10:00:00.000Z', null, null])
    })

    it('decodes {__bigint} and {__blob} in response values', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(OK([{
            big: {__bigint: '12345678901234567890'},
            data: {__blob: 'AQID'},
        }])), {status: 200}))
        const a = new D1HttpAdapter({url: 'https://x', authToken: 't'})
        const r = await a.run<{big: bigint, data: Uint8Array}>('SELECT * FROM t', [])
        expect(typeof r.results[0].big).toBe('bigint')
        expect(r.results[0].big).toBe(12345678901234567890n)
        expect(r.results[0].data).toBeInstanceOf(Uint8Array)
        expect(Array.from(r.results[0].data)).toEqual([1, 2, 3])
    })

    it('throws on HTTP 401', async () => {
        fetchMock.mockResolvedValueOnce(new Response('unauthorized', {status: 401}))
        const a = new D1HttpAdapter({url: 'https://x', authToken: 't'})
        await expect(a.run('SELECT 1', [])).rejects.toThrow(/401/)
    })

    it('throws on HTTP 500 with error envelope', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            success: false, error: 'UNIQUE constraint failed: t.id', code: 'SQLITE_CONSTRAINT_UNIQUE',
        }), {status: 500}))
        const a = new D1HttpAdapter({url: 'https://x', authToken: 't'})
        await expect(a.run('INSERT INTO t VALUES (1)', [])).rejects.toThrow(/UNIQUE constraint/)
    })

    it('throws on {success:false} in 200-response body (defensive)', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({success: false, error: 'bad shape'}), {status: 200}))
        const a = new D1HttpAdapter({url: 'https://x', authToken: 't'})
        await expect(a.run('x', [])).rejects.toThrow(/bad shape/)
    })

    it('rejects plain object bind values', async () => {
        const a = new D1HttpAdapter({url: 'https://x', authToken: 't'})
        await expect(a.run('x', [{foo: 'bar'} as any])).rejects.toThrow()
    })
})

describe('D1HttpAdapter.runBatch', () => {
    let fetchMock: any
    beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

    it('POSTs to /query/batch/ with wrapped {queries:[...]} body, returns per-statement results', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
            OK2([{a: 1}], {rows_read: 1}),
            OK2([], {rows_written: 1}),
        ]), {status: 200}))
        const a = new D1HttpAdapter({url: 'https://x', authToken: 't'})
        const r = await a.runBatch<any>([
            {q: 'SELECT a FROM t', v: []},
            {q: 'INSERT INTO t VALUES (?)', v: [1]},
        ])
        const body = JSON.parse(fetchMock.mock.calls[0][1].body)
        expect(body).toEqual({queries: [
            {sql: 'SELECT a FROM t', params: []},
            {sql: 'INSERT INTO t VALUES (?)', params: [1]},
        ]})
        expect(r).toHaveLength(2)
        expect(r[0].results).toEqual([{a: 1}])
    })

    it('returns empty array for empty input without calling fetch', async () => {
        const a = new D1HttpAdapter({url: 'https://x', authToken: 't'})
        expect(await a.runBatch([])).toEqual([])
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('throws on 500 with error body (atomic failure on server)', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            success: false, error: 'FOREIGN KEY constraint failed', code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
        }), {status: 500}))
        const a = new D1HttpAdapter({url: 'https://x', authToken: 't'})
        await expect(a.runBatch([
            {q: 'INSERT INTO a VALUES (1)', v: []},
            {q: 'INSERT INTO b VALUES (99)', v: []},
        ])).rejects.toThrow(/FOREIGN KEY/)
    })
})

function OK2(results: any[], meta: any = {}) {
    return {
        results, success: true,
        meta: {duration: 0.1, changes: 0, last_row_id: 0, changed_db: false, size_after: 0,
               rows_read: 0, rows_written: 0, served_by: 'self-hosted', served_by_region: 'local', served_by_primary_region: 'local',
               ...meta},
    }
}
