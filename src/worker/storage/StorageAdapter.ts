/**
 * Result from a query execution.
 * Backend-agnostic — D1, DO SQLite, Postgres, etc. all return this shape.
 *
 * On success: success=true, results contains rows.
 * On failure: adapters throw — this type only represents successful results.
 * The error field exists for backends that may include error info alongside partial results.
 */
export interface QueryResult<T = unknown> {
    success: boolean
    results: T[]
    error?: string
    meta?: {
        rows_read?: number
        rows_written?: number
    }
}

/**
 * Immutable prepared query — holds a parameterized SQL query and its bind values.
 * Once created, the query string and values cannot be modified.
 */
export class PreparedQuery {
    readonly q: string
    readonly v: readonly any[]
    constructor(q: string, v: any[]) {
        this.q = q
        this.v = Object.freeze([...v])
        Object.freeze(this)
    }
}

/**
 * Storage adapter interface for database backends.
 * Abstracts the execution of parameterized SQL queries.
 *
 * Each backend (D1, DO SQLite, Postgres, etc.) implements this interface
 * to translate generic {q, v} queries into backend-specific execution.
 *
 * Error contract: adapters throw on failure. Callers are responsible for
 * catching exceptions. QueryResult represents successful execution only.
 */
export interface StorageAdapter {
    /**
     * Execute a single parameterized query.
     * @param q - SQL query string with ? placeholders
     * @param v - Bind values for the placeholders
     * @throws on query failure (backend-specific error)
     */
    run<T = unknown>(q: string, v: readonly any[]): Promise<QueryResult<T>>

    /**
     * Execute multiple queries as an atomic batch/transaction.
     * All queries succeed or all fail (backend determines transaction semantics).
     * Returns results per query, indexed same as input.
     * @throws on failure — entire batch is rolled back
     *
     * - D1: uses database.batch() (implicit transaction)
     * - DO SQLite: uses transactionSync() with sequential exec()
     * - Postgres: uses BEGIN/COMMIT with sequential queries
     */
    runBatch<T = unknown>(queries: {q: string, v: readonly any[]}[]): Promise<QueryResult<T>[]>
}
