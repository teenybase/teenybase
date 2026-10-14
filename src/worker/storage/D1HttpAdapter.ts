import type {StorageAdapter, QueryResult} from './StorageAdapter'

export interface D1HttpAdapterOptions {
    /** Base URL of the d1-http-server (https://host). Trailing slash is tolerated. */
    url: string
    /** Bearer token the server validates against its AUTH_TOKENS env. */
    authToken?: string
    /** Fetch override for testing. Defaults to globalThis.fetch. */
    fetch?: typeof fetch
}

// ---------- server envelope types ----------
interface QueryMeta {
    duration: number
    changes: number
    last_row_id: number
    changed_db: boolean
    size_after: number
    rows_read: number
    rows_written: number
    served_by?: string
    served_by_region?: string
    served_by_primary_region?: string
}

interface OkResponse {
    results: Record<string, unknown>[]
    success: true
    meta: QueryMeta
}

interface ErrResponse {
    success: false
    error: string
    code?: string
    cause?: unknown
}

// ---------- encoding (bind values, client → server) ----------
function encodeBind(v: unknown): unknown {
    if (v === null || v === undefined) return null
    if (typeof v === 'boolean') return v ? 1 : 0
    if (typeof v === 'bigint') return {__bigint: v.toString()}
    if (typeof v === 'number' || typeof v === 'string') return v
    if (v instanceof Date) return v.toISOString()
    if (v instanceof Uint8Array) return {__blob: uint8ToBase64(v)}
    if (v instanceof ArrayBuffer) return {__blob: uint8ToBase64(new Uint8Array(v))}
    if (ArrayBuffer.isView(v)) {
        const u = v as unknown as {buffer: ArrayBufferLike, byteOffset: number, byteLength: number}
        return {__blob: uint8ToBase64(new Uint8Array(u.buffer, u.byteOffset, u.byteLength))}
    }
    throw new Error(`D1HttpAdapter: unsupported bind type: ${typeof v === 'object' ? (v as any)?.constructor?.name ?? 'object' : typeof v}`)
}

// ---------- decoding (server → client) ----------
function decodeValue(v: unknown): unknown {
    if (v === null || typeof v !== 'object') return v
    const o = v as Record<string, unknown>
    if ('__bigint' in o && typeof o.__bigint === 'string') return BigInt(o.__bigint)
    if ('__blob' in o && typeof o.__blob === 'string') return base64ToUint8(o.__blob)
    return v
}
function decodeRow(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const k in row) out[k] = decodeValue(row[k])
    return out
}

// ---------- base64 helpers ----------
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

// ---------- the adapter ----------
export class D1HttpAdapter implements StorageAdapter {
    private readonly base: string
    private readonly headers: Record<string, string>
    private readonly fetchFn: typeof fetch

    constructor(opts: D1HttpAdapterOptions) {
        if (!opts.url) throw new Error('D1HttpAdapter: url required')
        this.base = opts.url.replace(/\/$/, '')
        this.headers = {'Content-Type': 'application/json'}
        if (opts.authToken) this.headers['Authorization'] = `Bearer ${opts.authToken}`
        // Bind to globalThis so `this.fetchFn(...)` doesn't trip "Illegal invocation" in Workers.
        // globalThis.fetch requires this=globalThis (or undefined); invoking as a method loses that.
        const f = opts.fetch ?? globalThis.fetch
        this.fetchFn = f.bind(globalThis)
    }

    async run<T = unknown>(q: string, v: readonly any[]): Promise<QueryResult<T>> {
        const body = JSON.stringify({sql: q, params: Array.from(v).map(encodeBind)})
        const res = await this.fetchFn(`${this.base}/query/all/`, {method: 'POST', headers: this.headers, body})
        const env = await this.parseEnvelope(res)
        return this.toQueryResult<T>(env)
    }

    async runBatch<T = unknown>(queries: {q: string, v: readonly any[]}[]): Promise<QueryResult<T>[]> {
        if (!queries.length) return []
        const body = JSON.stringify({queries: queries.map(q => ({sql: q.q, params: Array.from(q.v).map(encodeBind)}))})
        const res = await this.fetchFn(`${this.base}/query/batch/`, {method: 'POST', headers: this.headers, body})
        // Server returns a bare JSON array on success, or an error envelope on failure (500)
        if (!res.ok) {
            const err = await this.tryParseError(res)
            throw new Error(`D1HttpAdapter: ${err}`)
        }
        let parsed: unknown
        try { parsed = await res.json() } catch { throw new Error(`D1HttpAdapter: non-JSON batch response`) }
        if (!Array.isArray(parsed)) {
            // Defensive: server contract says array on 200; anything else is an error shape.
            const env = parsed as ErrResponse
            throw new Error(`D1HttpAdapter: ${env?.error ?? 'unexpected batch response shape'}`)
        }
        return (parsed as OkResponse[]).map(el => this.toQueryResult<T>(el))
    }

    private async parseEnvelope(res: Response): Promise<OkResponse> {
        if (!res.ok) throw new Error(`D1HttpAdapter: ${await this.tryParseError(res)}`)
        let parsed: unknown
        try { parsed = await res.json() } catch { throw new Error(`D1HttpAdapter: HTTP ${res.status} — non-JSON body`) }
        const env = parsed as OkResponse | ErrResponse
        if (!('success' in env) || !env.success) {
            const err = (env as ErrResponse).error ?? 'unknown error'
            throw new Error(`D1HttpAdapter: ${err}`)
        }
        return env as OkResponse
    }

    private async tryParseError(res: Response): Promise<string> {
        const text = await res.text().catch(() => '')
        try {
            const env = JSON.parse(text) as ErrResponse
            if (env?.error) return `HTTP ${res.status}: ${env.error}`
        } catch { /* not JSON */ }
        return `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`
    }

    private toQueryResult<T>(env: OkResponse): QueryResult<T> {
        return {
            success: true,
            results: env.results.map(decodeRow) as T[],
            meta: {rows_read: env.meta?.rows_read, rows_written: env.meta?.rows_written},
        }
    }
}
