import {StorageAdapter, QueryResult} from './StorageAdapter'

/**
 * StorageAdapter implementation for Cloudflare D1.
 * Translates generic query execution into D1's prepare/bind/run API.
 *
 * D1 throws on failure (never returns {success: false}) — callers must
 * handle exceptions. This matches StorageAdapter's contract where errors
 * are thrown, not returned in QueryResult.
 *
 * D1Result<T> is structurally compatible with QueryResult<T> — both have
 * success, results, and compatible meta/error fields — so results are
 * returned directly without field-by-field copying.
 */
export class D1Adapter implements StorageAdapter {
    constructor(private readonly db: D1Database) {}

    async run<T = unknown>(q: string, v: readonly any[]): Promise<QueryResult<T>> {
        return this.db.prepare(q).bind(...v).run<T>()
    }

    async runBatch<T = unknown>(queries: {q: string, v: readonly any[]}[]): Promise<QueryResult<T>[]> {
        if (!queries.length) return []
        const statements = queries.map(qr => this.db.prepare(qr.q).bind(...qr.v))
        return this.db.batch<T>(statements)
    }
}
