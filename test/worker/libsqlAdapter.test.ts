import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'
import {LibsqlAdapter} from '../../src/worker/storage/LibsqlAdapter'

const OK_EXECUTE = (cols: {name: string}[], rows: any[][], meta: any = {}) => ({
    baton: null, base_url: null,
    results: [
        {type: 'ok', response: {type: 'execute', result: {
            cols, rows,
            affected_row_count: meta.affected_row_count ?? 0,
            last_insert_rowid: meta.last_insert_rowid ?? '0',
            rows_read: meta.rows_read ?? rows.length,
            rows_written: meta.rows_written ?? 0,
        }}},
        {type: 'ok', response: {type: 'close'}},
    ],
})

describe('LibsqlAdapter.run', () => {
    let fetchMock: any
    beforeEach(() => { fetchMock = vi.fn(); globalThis.fetch = fetchMock })
    afterEach(() => { vi.restoreAllMocks() })

    it('POSTs to /v2/pipeline with auth header and tagged-value args', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(OK_EXECUTE(
            [{name: 'a'}], [[{type: 'integer', value: '1'}]],
        )), {status: 200}))
        const a = new LibsqlAdapter({url: 'https://db.turso.io', authToken: 'TOK'})
        const r = await a.run<{a: number}>('SELECT a FROM t WHERE a = ?', [1])

        expect(fetchMock).toHaveBeenCalledOnce()
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('https://db.turso.io/v2/pipeline')
        expect(init.method).toBe('POST')
        expect(init.headers['Authorization']).toBe('Bearer TOK')
        expect(init.headers['Content-Type']).toBe('application/json')

        const body = JSON.parse(init.body)
        expect(body.baton).toBeNull()
        expect(body.requests).toHaveLength(2)
        expect(body.requests[0]).toEqual({
            type: 'execute',
            stmt: {sql: 'SELECT a FROM t WHERE a = ?', args: [{type: 'integer', value: '1'}]},
        })
        expect(body.requests[1]).toEqual({type: 'close'})

        expect(r.success).toBe(true)
        expect(r.results).toEqual([{a: 1}])
    })

    it('encodes value types correctly: null, boolean, number, bigint, string, Uint8Array', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(OK_EXECUTE([], [])), {status: 200}))
        const a = new LibsqlAdapter({url: 'https://x', authToken: 't'})
        const bytes = new Uint8Array([1, 2, 3])
        await a.run('INSERT INTO t VALUES (?,?,?,?,?,?)',
            [null, true, 3.14, 12345678901234567890n, 'hi', bytes])

        const args = JSON.parse(fetchMock.mock.calls[0][1].body).requests[0].stmt.args
        expect(args).toEqual([
            {type: 'null'},
            {type: 'integer', value: '1'},                    // boolean true → integer 1
            {type: 'float', value: 3.14},
            {type: 'integer', value: '12345678901234567890'}, // BigInt preserved as string
            {type: 'text', value: 'hi'},
            {type: 'blob', base64: 'AQID'},                   // [1,2,3] base64
        ])
    })

    it('decodes response values: integer/string → number, text → string, null → null, blob → Uint8Array', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(OK_EXECUTE(
            [{name: 'i'}, {name: 's'}, {name: 'n'}, {name: 'b'}, {name: 'f'}],
            [[
                {type: 'integer', value: '42'},
                {type: 'text', value: 'hi'},
                {type: 'null'},
                {type: 'blob', base64: 'AQID'},
                {type: 'float', value: 3.14},
            ]],
        )), {status: 200}))
        const a = new LibsqlAdapter({url: 'https://x', authToken: 't'})
        const r = await a.run<{i: number, s: string, n: null, b: Uint8Array, f: number}>('SELECT *', [])

        const row = r.results[0]
        expect(row.i).toBe(42)
        expect(row.s).toBe('hi')
        expect(row.n).toBeNull()
        expect(row.b).toBeInstanceOf(Uint8Array)
        expect(Array.from(row.b)).toEqual([1, 2, 3])
        expect(row.f).toBe(3.14)
    })

    it('large integers that exceed safe range come back as bigint', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(OK_EXECUTE(
            [{name: 'big'}], [[{type: 'integer', value: '12345678901234567890'}]],
        )), {status: 200}))
        const a = new LibsqlAdapter({url: 'https://x', authToken: 't'})
        const r = await a.run<{big: bigint}>('SELECT big FROM t', [])
        expect(typeof r.results[0].big).toBe('bigint')
        expect(r.results[0].big).toBe(12345678901234567890n)
    })

    it('throws on per-statement error surfaced by sqld', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            baton: null, base_url: null,
            results: [
                {type: 'error', error: {message: 'UNIQUE constraint failed: t.id', code: 'SQLITE_CONSTRAINT_UNIQUE'}},
            ],
        }), {status: 200}))
        const a = new LibsqlAdapter({url: 'https://x', authToken: 't'})
        await expect(a.run('INSERT INTO t VALUES (1)', [])).rejects.toThrow(/UNIQUE constraint/)
    })

    it('throws on HTTP 401', async () => {
        fetchMock.mockResolvedValueOnce(new Response('auth failed', {status: 401}))
        const a = new LibsqlAdapter({url: 'https://x', authToken: 't'})
        await expect(a.run('SELECT 1', [])).rejects.toThrow(/401/)
    })

    it('rejects Date and plain object bind values', async () => {
        const a = new LibsqlAdapter({url: 'https://x', authToken: 't'})
        await expect(a.run('x', [new Date() as any])).rejects.toThrow()
        await expect(a.run('x', [{foo: 'bar'} as any])).rejects.toThrow()
    })

    it('omits authToken header for local urls when not provided (file:/:memory:)', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(OK_EXECUTE([], [])), {status: 200}))
        const a = new LibsqlAdapter({url: 'http://localhost:8080'})   // no authToken
        await a.run('SELECT 1', [])
        const headers = fetchMock.mock.calls[0][1].headers
        expect(headers['Authorization']).toBeUndefined()
    })
})

describe('LibsqlAdapter.runBatch', () => {
    let fetchMock: any
    beforeEach(() => { fetchMock = vi.fn(); globalThis.fetch = fetchMock })
    afterEach(() => { vi.restoreAllMocks() })

    function batchOk(stepResults: Array<{cols: {name: string}[], rows: any[][]}|null>, stepErrors: any[] = []) {
        return {
            baton: null, base_url: null,
            results: [
                {type: 'ok', response: {type: 'batch', result: {
                    step_results: stepResults.map(s => s && ({
                        cols: s.cols, rows: s.rows,
                        affected_row_count: 0, last_insert_rowid: '0',
                        rows_read: s.rows.length, rows_written: 0,
                    })),
                    step_errors: stepResults.map((_, i) => stepErrors[i] ?? null),
                }}},
                {type: 'ok', response: {type: 'close'}},
            ],
        }
    }

    it('sends one batch request with step conditions and returns per-step results', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(batchOk([
            {cols: [{name: 'a'}], rows: [[{type: 'integer', value: '1'}]]},
            {cols: [], rows: []},
        ])), {status: 200}))
        const a = new LibsqlAdapter({url: 'https://x', authToken: 't'})
        const r = await a.runBatch<{a: number}>([
            {q: 'SELECT a FROM t', v: []},
            {q: 'INSERT INTO t VALUES (?)', v: [2]},
        ])

        const body = JSON.parse(fetchMock.mock.calls[0][1].body)
        expect(body.requests[0].type).toBe('batch')
        expect(body.requests[0].batch.steps).toHaveLength(2)
        expect(body.requests[0].batch.steps[0].condition).toBeUndefined()
        expect(body.requests[0].batch.steps[1].condition).toEqual({type: 'ok', step: 0})

        expect(r).toHaveLength(2)
        expect(r[0].results).toEqual([{a: 1}])
    })

    it('returns empty array for empty input without calling fetch', async () => {
        const a = new LibsqlAdapter({url: 'https://x', authToken: 't'})
        expect(await a.runBatch([])).toEqual([])
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('throws on per-step error with index and message', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(batchOk(
            [{cols: [], rows: []}, null],
            [null, {message: 'FOREIGN KEY constraint failed', code: 'SQLITE_CONSTRAINT_FOREIGNKEY'}],
        )), {status: 200}))
        const a = new LibsqlAdapter({url: 'https://x', authToken: 't'})
        await expect(a.runBatch([
            {q: 'INSERT INTO a VALUES (1)', v: []},
            {q: 'INSERT INTO b VALUES (99)', v: []},
        ])).rejects.toThrow(/batch\[1\].*FOREIGN KEY/)
    })
})
