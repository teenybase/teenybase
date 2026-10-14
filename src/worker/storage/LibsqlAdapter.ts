import type {StorageAdapter, QueryResult} from './StorageAdapter'

export interface LibsqlAdapterOptions {
    /** libsql:// / https:// / wss:// / http:// URL. `file:` and `:memory:` are NOT supported (require native addon). */
    url: string
    /** Bearer token (Turso auth token or sqld JWT). Optional for unauthenticated local servers. */
    authToken?: string
    /** Fetch override for testing. Defaults to globalThis.fetch. */
    fetch?: typeof fetch
}

// ---------- Hrana 3 value types ----------
type HranaValue =
    | {type: 'null'}
    | {type: 'integer', value: string}
    | {type: 'float', value: number}
    | {type: 'text', value: string}
    | {type: 'blob', base64: string}

interface HranaStmt {sql: string, args: HranaValue[]}

interface HranaExecuteResult {
    cols: {name: string | null, decltype: string | null}[]
    rows: HranaValue[][]
    affected_row_count: number
    last_insert_rowid: string | null
    rows_read: number
    rows_written: number
    query_duration_ms?: number
}

type HranaStreamResult =
    | {type: 'ok', response:
        | {type: 'execute', result: HranaExecuteResult}
        | {type: 'batch', result: {step_results: (HranaExecuteResult | null)[], step_errors: (HranaError | null)[]}}
        | {type: 'close'}}
    | {type: 'error', error: HranaError}

interface HranaError {message: string, code?: string | null}

interface HranaResponse {baton: string | null, base_url: string | null, results: HranaStreamResult[]}

// ---------- value encode ----------
function encodeBind(v: unknown): HranaValue {
    if (v === null || v === undefined) return {type: 'null'}
    if (typeof v === 'boolean') return {type: 'integer', value: v ? '1' : '0'}
    if (typeof v === 'bigint') return {type: 'integer', value: v.toString()}
    if (typeof v === 'number') {
        if (Number.isInteger(v)) return {type: 'integer', value: v.toString()}
        return {type: 'float', value: v}
    }
    if (typeof v === 'string') return {type: 'text', value: v}
    if (v instanceof Uint8Array) return {type: 'blob', base64: uint8ToBase64(v)}
    if (v instanceof ArrayBuffer) return {type: 'blob', base64: uint8ToBase64(new Uint8Array(v))}
    if (ArrayBuffer.isView(v)) {
        const u = v as unknown as {buffer: ArrayBufferLike, byteOffset: number, byteLength: number}
        return {type: 'blob', base64: uint8ToBase64(new Uint8Array(u.buffer, u.byteOffset, u.byteLength))}
    }
    throw new Error(`LibsqlAdapter: unsupported bind type: ${typeof v === 'object' ? (v as any)?.constructor?.name ?? 'object' : typeof v}`)
}

// ---------- value decode ----------
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)

function decodeValue(v: HranaValue): unknown {
    switch (v.type) {
        case 'null':    return null
        case 'text':    return v.value
        case 'float':   return v.value
        case 'blob':    return base64ToUint8(v.base64)
        case 'integer': {
            const big = BigInt(v.value)
            return (big > MAX_SAFE || big < MIN_SAFE) ? big : Number(big)
        }
    }
}

// ---------- base64 helpers (worker-safe, no atob/btoa on Uint8Array) ----------
function uint8ToBase64(u: Uint8Array): string {
    let s = ''
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i])
    return btoa(s)
}
function base64ToUint8(b64: string): Uint8Array {
    const s = atob(b64)
    const out = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
    return out
}

// ---------- row zipping ----------
function zipRow<T>(cols: {name: string | null}[], row: HranaValue[]): T {
    const out: Record<string, unknown> = {}
    for (let i = 0; i < cols.length; i++) {
        const name = cols[i]?.name ?? String(i)
        out[name] = decodeValue(row[i])
    }
    return out as T
}

function toQueryResult<T>(r: HranaExecuteResult): QueryResult<T> {
    return {
        success: true,
        results: r.rows.map(row => zipRow<T>(r.cols, row)),
        meta: {rows_read: r.rows_read, rows_written: r.rows_written},
    }
}

// ---------- the adapter ----------
export class LibsqlAdapter implements StorageAdapter {
    private readonly url: string
    private readonly headers: Record<string, string>
    private readonly fetchFn: typeof fetch

    constructor(opts: LibsqlAdapterOptions) {
        if (!opts.url) throw new Error('LibsqlAdapter: url required')
        // Normalize: strip trailing slash, then append /v2/pipeline (v2 is stable; v3 is compatible but v2 is the documented baseline)
        const base = opts.url.replace(/\/$/, '')
        this.url = `${base}/v2/pipeline`
        this.headers = {'Content-Type': 'application/json'}
        if (opts.authToken) this.headers['Authorization'] = `Bearer ${opts.authToken}`
        // Bind to globalThis so `this.fetchFn(...)` doesn't trip "Illegal invocation" in Workers.
        const f = opts.fetch ?? globalThis.fetch
        this.fetchFn = f.bind(globalThis)
    }

    async run<T = unknown>(q: string, v: readonly any[]): Promise<QueryResult<T>> {
        const body = JSON.stringify({
            baton: null,
            requests: [
                {type: 'execute', stmt: this.toStmt(q, v)},
                {type: 'close'},
            ],
        })
        const resp = await this.sendPipeline<T>(body)
        const first = resp.results[0]
        if (first.type === 'error') throw new Error(`LibsqlAdapter: ${first.error.message}`)
        if (first.response.type !== 'execute') throw new Error(`LibsqlAdapter: unexpected response type ${first.response.type}`)
        return toQueryResult<T>(first.response.result)
    }

    async runBatch<T = unknown>(queries: {q: string, v: readonly any[]}[]): Promise<QueryResult<T>[]> {
        if (!queries.length) return []
        // Build atomic batch: step 0 runs unconditionally; steps 1..N gated on ok(step-1) so a
        // failing step short-circuits the rest. sqld wraps the whole batch in BEGIN IMMEDIATE/COMMIT.
        const steps = queries.map((q, i) => {
            const step: any = {stmt: this.toStmt(q.q, q.v)}
            if (i > 0) step.condition = {type: 'ok', step: i - 1}
            return step
        })
        const body = JSON.stringify({
            baton: null,
            requests: [
                {type: 'batch', batch: {steps}},
                {type: 'close'},
            ],
        })
        const resp = await this.sendPipeline<T>(body)
        const first = resp.results[0]
        if (first.type === 'error') throw new Error(`LibsqlAdapter: ${first.error.message}`)
        if (first.response.type !== 'batch') throw new Error(`LibsqlAdapter: unexpected response type ${first.response.type}`)

        const {step_results, step_errors} = first.response.result
        for (let i = 0; i < step_errors.length; i++) {
            const err = step_errors[i]
            if (err) throw new Error(`LibsqlAdapter: batch[${i}] failed: ${err.message}`)
        }
        return step_results.map((r, i) => {
            if (!r) throw new Error(`LibsqlAdapter: batch[${i}] skipped without error — likely due to short-circuited prior step`)
            return toQueryResult<T>(r)
        })
    }

    private toStmt(q: string, v: readonly any[]): HranaStmt {
        return {sql: q, args: Array.from(v).map(encodeBind)}
    }

    private async sendPipeline<T>(body: string): Promise<HranaResponse> {
        const res = await this.fetchFn(this.url, {method: 'POST', headers: this.headers, body})
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            throw new Error(`LibsqlAdapter: HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
        }
        let parsed: HranaResponse
        try { parsed = await res.json() as HranaResponse }
        catch { throw new Error(`LibsqlAdapter: HTTP ${res.status} — non-JSON body`) }
        return parsed
    }
}
