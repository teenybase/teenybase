import {$DatabaseRaw} from './$Database'
import {$Env} from './env'
import {D1Query} from '../sql/build/d1'

export class InternalKV/*<T extends $Env = $Env>*/ {
    constructor(protected readonly db: $DatabaseRaw/*<T>*/, readonly tableName = '_ddb_internal_kv') {
    }

    async setup(version: number){
        if(version >= 0) {
            const sql = `
            CREATE TABLE IF NOT EXISTS "${this.tableName}" (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                expiry INTEGER NULL
            )`.split('\n').map(l => l.trim()).join(' ')
            await this.db.rawSQL({q: sql, v: []}).run()
        }
    }

    async get<T extends string|number = string>(key: string, field?: string) {
        const rnd = '_' + Math.random().toString(36).substring(7)
        const q = `SELECT (${field || 'value'}) as ${rnd} FROM ${this.tableName} WHERE key = ? AND (expiry IS NULL OR expiry > unixepoch(CURRENT_TIMESTAMP))`
        const res = await this.db.rawSQL<any>({q, v: [key]}).run()
        return res?.[0] ? res[0][rnd] as T : null
    }

    async pop<T extends string|number = string>(key: string, field?: string) {
        const rnd = '_' + Math.random().toString(36).substring(7)
        const q = `DELETE FROM ${this.tableName} WHERE key = ? AND (expiry IS NULL OR expiry > unixepoch(CURRENT_TIMESTAMP)) RETURNING (${field || 'value'}) as ${rnd}`
        const res = await this.db.rawSQL<any>({q, v: [key]}).run()
        return res?.[0] ? res[0][rnd] as T : null
    }

    async get2<T>(key: string, ...fields: string[]) {
        const q = `SELECT value, expiry, ${fields.join(', ')} FROM ${this.tableName} WHERE key = ? AND (expiry IS NULL OR expiry > unixepoch(CURRENT_TIMESTAMP))`
        const res = await this.db.rawSQL<{ value: string, expiry?: number } & T>({q, v: [key]}).run()
        return res?.[0] || null
    }

    async set(key: string, value: string | { sql: string }, expiryOffsetSeconds?: number) {
        return this.db.rawSQL(this.setQuery(key, value, expiryOffsetSeconds)).run()
    }

    setQuery(key: string, value: string | { sql: string }, expiryOffsetSeconds?: number) {
        const s = typeof value !== 'string'
        if(typeof expiryOffsetSeconds !== 'number' || isNaN(expiryOffsetSeconds)) {
            expiryOffsetSeconds = 1
        }
        const q = `INSERT OR REPLACE INTO ${this.tableName} (key, value, expiry) VALUES (?, ${s ? value.sql || "''" : "?"}, ${expiryOffsetSeconds ? `unixepoch(CURRENT_TIMESTAMP) + ${expiryOffsetSeconds}` : 'NULL'})`
        const b = [key]
        if(!s) b.push(value)
        return {q, v: b} as D1Query
    }

    async setMultiple(data: Record<string, (string | { sql: string })>, expiryOffsetSeconds?: number) {
        const qs = [] as string[]
        const b = []
        const expiry = expiryOffsetSeconds ? `unixepoch(CURRENT_TIMESTAMP) + ${expiryOffsetSeconds}` : 'NULL'
        for (const [key, value] of Object.entries(data)) {
            const s = typeof value !== 'string'
            qs.push(`(?, ${s ? value.sql || "''" : "?"}, ${expiry})`)
            b.push(key)
            if(!s) b.push(value)
        }
        const q = `INSERT OR REPLACE INTO ${this.tableName} (key, value, expiry) VALUES ${qs.join(', ')}`
        return this.db.rawSQL({q, v: b}).run()
    }

    async remove(key: string) {
        const q = `DELETE FROM ${this.tableName} WHERE key = ?`
        await this.db.rawSQL({q, v: [key]}).run()
    }

    async setSql(key: string, value: string, expiryOffsetSeconds?: number) {
        return await this.set(key, {sql: value}, expiryOffsetSeconds)
    }

}
