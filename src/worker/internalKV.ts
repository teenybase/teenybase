import {$DatabaseRaw} from './$DatabaseRawImpl'
import {D1Query} from '../sql/build/d1'
import type {DBMigration} from './migrationHelper'

export class InternalKV/*<T extends $Env = $Env>*/ {
    private readonly tn: string
    constructor(protected readonly db: $DatabaseRaw, readonly tableName = '_ddb_internal_kv') {
        this.tn = `"${tableName}"`
    }

    // Pure entry-build: single source of truth for the name/sql/revert triple.
    // setup() runs + returns it; preview endpoints can call this without side effects.
    // Fixed 00000 prefix reserves an infra slot distinct from user migrations (≥ 10000).
    previewEntry(version: number): Omit<DBMigration, 'id'> | null {
        if (version < 0) return null
        const sql = `CREATE TABLE IF NOT EXISTS ${this.tn} (key TEXT PRIMARY KEY, value TEXT NOT NULL, expiry INTEGER NULL)`
        return {
            name: '00000_create_internal_kv.sql',
            sql,
            sql_revert: `DROP TABLE IF EXISTS ${this.tn}`,
        }
    }

    async setup(version: number): Promise<Omit<DBMigration, 'id'> | null> {
        const entry = this.previewEntry(version)
        if (!entry) return null
        await this.db.rawSQL({q: entry.sql, v: []}).run()
        return entry
    }

    async get<T extends string|number = string>(key: string, field?: string) {
        const rnd = '_' + Math.random().toString(36).substring(7)
        const q = `SELECT (${field || 'value'}) as ${rnd} FROM ${this.tn} WHERE key = ? AND (expiry IS NULL OR expiry > unixepoch(CURRENT_TIMESTAMP))`
        const res = await this.db.rawSQL<any>({q, v: [key]}).run()
        return res?.[0] ? res[0][rnd] as T : null
    }

    // Returns the SELECT as a D1Query so callers can batch reads (see MigrationHelperRaw.dbSettings).
    // Column alias is `value` for direct row-shape consumption.
    getQuery(key: string, field = 'value'): D1Query {
        return {
            q: `SELECT ${field} AS value FROM ${this.tn} WHERE key = ? AND (expiry IS NULL OR expiry > unixepoch(CURRENT_TIMESTAMP))`,
            v: [key],
        }
    }

    // CAS verify statement: succeeds when `key`'s current value matches `expected`
    // (stored as TEXT, so numbers are coerced via String()). On mismatch, json() on a
    // non-JSON literal raises "malformed JSON" → SQLite aborts the enclosing
    // rawSQLTransaction batch. `expected === null` checks "row does not exist" via
    // SQL-level IS NULL — no sentinel string required.
    casVerifyQuery(key: string, expected: string | number | null): D1Query {
        const match = expected === null ? 'IS NULL' : '= ?'
        return {
            q: `SELECT json(CASE WHEN (SELECT value FROM ${this.tn} WHERE key = ?) ${match} THEN '{}' ELSE 'version_conflict' END)`,
            v: expected === null ? [key] : [key, String(expected)],
        }
    }

    async pop<T extends string|number = string>(key: string, field?: string) {
        const rnd = '_' + Math.random().toString(36).substring(7)
        const q = `DELETE FROM ${this.tn} WHERE key = ? AND (expiry IS NULL OR expiry > unixepoch(CURRENT_TIMESTAMP)) RETURNING (${field || 'value'}) as ${rnd}`
        const res = await this.db.rawSQL<any>({q, v: [key]}).run()
        return res?.[0] ? res[0][rnd] as T : null
    }

    async get2<T>(key: string, ...fields: string[]) {
        const q = `SELECT value, expiry, ${fields.join(', ')} FROM ${this.tn} WHERE key = ? AND (expiry IS NULL OR expiry > unixepoch(CURRENT_TIMESTAMP))`
        const res = await this.db.rawSQL<{ value: string, expiry?: number } & T>({q, v: [key]}).run()
        return res?.[0] || null
    }

    async set(key: string, value: string | { sql: string }, expiryOffsetSeconds?: number) {
        return this.db.rawSQL(this.setQuery(key, value, expiryOffsetSeconds)).run()
    }

    setQuery(key: string, value: string | { sql: string }, expiryOffsetSeconds?: number) {
        const s = typeof value !== 'string'
        if(expiryOffsetSeconds !== undefined && (typeof expiryOffsetSeconds !== 'number' || isNaN(expiryOffsetSeconds))) {
            expiryOffsetSeconds = 1 // expire in 1 sec(for temp data)
        }
        const q = `INSERT OR REPLACE INTO ${this.tn} (key, value, expiry) VALUES (?, ${s ? value.sql || "''" : "?"}, ${expiryOffsetSeconds ? `unixepoch(CURRENT_TIMESTAMP) + ${expiryOffsetSeconds}` : 'NULL'})`
        const b = [key]
        if(!s) b.push(value)
        return {q, v: b} as D1Query
    }

    async setMultiple(data: Record<string, (string | { sql: string })>, expiryOffsetSeconds?: number) {
        const qs = [] as string[]
        const b = []
        if(expiryOffsetSeconds !== undefined && (typeof expiryOffsetSeconds !== 'number' || isNaN(expiryOffsetSeconds))) {
            expiryOffsetSeconds = 1 // expire in 1 sec(for temp data)
        }
        const expiry = expiryOffsetSeconds ? `unixepoch(CURRENT_TIMESTAMP) + ${expiryOffsetSeconds}` : 'NULL'
        for (const [key, value] of Object.entries(data)) {
            const s = typeof value !== 'string'
            qs.push(`(?, ${s ? value.sql || "''" : "?"}, ${expiry})`)
            b.push(key)
            if(!s) b.push(value)
        }
        const q = `INSERT OR REPLACE INTO ${this.tn} (key, value, expiry) VALUES ${qs.join(', ')}`
        return this.db.rawSQL({q, v: b}).run()
    }

    async remove(key: string) {
        const q = `DELETE FROM ${this.tn} WHERE key = ?`
        await this.db.rawSQL({q, v: [key]}).run()
    }

    async removeByPrefix(prefix: string, exceptKey?: string) {
        const like = prefix.replace(/[%_\\]/g, '\\$&') + '%'
        if (exceptKey) {
            const q = `DELETE FROM ${this.tn} WHERE key LIKE ? ESCAPE '\\' AND key != ?`
            await this.db.rawSQL({q, v: [like, exceptKey]}).run()
        } else {
            const q = `DELETE FROM ${this.tn} WHERE key LIKE ? ESCAPE '\\'`
            await this.db.rawSQL({q, v: [like]}).run()
        }
    }

    async setSql(key: string, value: string, expiryOffsetSeconds?: number) {
        return await this.set(key, {sql: value}, expiryOffsetSeconds)
    }

}
