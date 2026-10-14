import type {StorageAdapter, QueryResult} from './StorageAdapter'

export interface D1RestAdapterOptions {
    accountId: string
    databaseId: string
    apiToken: string
    /** Override base URL for testing. Defaults to Cloudflare's public API. */
    baseUrl?: string
    /** Optional fetch override. Defaults to globalThis.fetch. */
    fetch?: typeof fetch
}

/**
 * Coerce a single bind value for the JSON payload. Mirrors the rules in
 * src/node/cloudflare/d1-api.ts:469-511:
 *   - null/undefined → null
 *   - boolean        → 1|0
 *   - number, string → passthrough
 *   - ArrayBuffer    → Array.from(new Uint8Array(v))  (D1 expects byte array)
 *   - ArrayBufferView→ Array.from(v)                  (typed arrays / DataView)
 *   - Array<number>  → passthrough (already a byte array)
 *   - anything else  → throw
 */
function coerceBind(v: unknown): unknown {
    if (v == null) return null
    if (typeof v === 'boolean') return v ? 1 : 0
    if (typeof v === 'number' || typeof v === 'string') return v
    if (v instanceof ArrayBuffer) return Array.from(new Uint8Array(v))
    if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>)
    if (Array.isArray(v) && v.every(x => typeof x === 'number' && x >= 0 && x < 256)) return v
    throw new Error(`D1RestAdapter: unsupported bind type: ${typeof v === 'object' ? (v as any)?.constructor?.name ?? 'object' : typeof v}`)
}

interface D1RestResultElement<T> {
    success: boolean
    meta: {
        duration?: number
        rows_read?: number
        rows_written?: number
        last_row_id?: number
        changes?: number
        changed_db?: boolean
        [k: string]: unknown
    }
    results: T[]
    error?: string
}

interface D1RestEnvelope<T> {
    success: boolean
    errors: {code?: number, message: string}[]
    messages: unknown[]
    result: D1RestResultElement<T>[] | null
}

/**
 * StorageAdapter that talks to a Cloudflare D1 database over the public REST API.
 * Use when a worker env binding isn't available (Node CLI, cross-account access,
 * or local dev). For production workers-to-D1 traffic, prefer the binding via D1Adapter.
 *
 * Contract:
 *   - throws on any failure (transport, top-level {success:false}, or per-statement error)
 *   - never returns a QueryResult with success:false
 *   - bind coercion matches the official D1 binding (see coerceBind above)
 */
export class D1RestAdapter implements StorageAdapter {
    private readonly url: string
    private readonly headers: Record<string, string>
    private readonly fetchFn: typeof fetch

    constructor(opts: D1RestAdapterOptions) {
        if (!opts.accountId) throw new Error('D1RestAdapter: accountId required')
        if (!opts.databaseId) throw new Error('D1RestAdapter: databaseId required')
        if (!opts.apiToken) throw new Error('D1RestAdapter: apiToken required')
        const base = (opts.baseUrl ?? 'https://api.cloudflare.com/client/v4').replace(/\/$/, '')
        this.url = `${base}/accounts/${encodeURIComponent(opts.accountId)}/d1/database/${encodeURIComponent(opts.databaseId)}/query`
        this.headers = {
            'Authorization': `Bearer ${opts.apiToken}`,
            'Content-Type': 'application/json',
        }
        // Bind to globalThis so `this.fetchFn(...)` doesn't trip "Illegal invocation" in Workers.
        const f = opts.fetch ?? globalThis.fetch
        this.fetchFn = f.bind(globalThis)
    }

    async run<T = unknown>(q: string, v: readonly any[]): Promise<QueryResult<T>> {
        const body = JSON.stringify({sql: q, params: Array.from(v).map(coerceBind)})
        const res = await this.fetchFn(this.url, {method: 'POST', headers: this.headers, body})
        const env = await this.parseEnvelope<T>(res)
        const first = env.result?.[0]
        if (!first) throw new Error('D1RestAdapter: empty result envelope')
        if (!first.success) throw new Error(`D1RestAdapter: ${first.error ?? 'query failed'}`)
        return {success: true, results: first.results, meta: {
            rows_read: first.meta.rows_read,
            rows_written: first.meta.rows_written,
        }}
    }

    async runBatch<T = unknown>(queries: {q: string, v: readonly any[]}[]): Promise<QueryResult<T>[]> {
        if (!queries.length) return []
        const body = JSON.stringify({
            batch: queries.map(q => ({sql: q.q, params: Array.from(q.v).map(coerceBind)})),
        })
        const res = await this.fetchFn(this.url, {method: 'POST', headers: this.headers, body})
        const env = await this.parseEnvelope<T>(res)
        if (!env.result) throw new Error('D1RestAdapter: missing result array in batch response')
        // Atomicity: if any element failed, the whole batch is a failure — throw with the first error.
        for (let i = 0; i < env.result.length; i++) {
            const el = env.result[i]
            if (!el.success) throw new Error(`D1RestAdapter: batch[${i}] failed: ${el.error ?? 'unknown'}`)
        }
        return env.result.map(el => ({success: true, results: el.results, meta: {
            rows_read: el.meta.rows_read,
            rows_written: el.meta.rows_written,
        }}))
    }

    private async parseEnvelope<T>(res: Response): Promise<D1RestEnvelope<T>> {
        let env: D1RestEnvelope<T>
        try {
            env = await res.json() as D1RestEnvelope<T>
        } catch (e) {
            throw new Error(`D1RestAdapter: HTTP ${res.status} ${res.statusText} — non-JSON body`)
        }
        if (!res.ok || !env.success) {
            const msg = env.errors?.[0]?.message ?? res.statusText
            throw new Error(`D1RestAdapter: HTTP ${res.status}: ${msg}`)
        }
        return env
    }
}
