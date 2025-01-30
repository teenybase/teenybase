import {$Database} from './$Database'
import {$Env} from './env'

export class InternalKV<T extends $Env = $Env> {
    constructor(private db: $Database<T>, readonly tableName = '_ddb_internal_kv') {
    }

    async setup(version: number){
        if(version >= 0) {
            const sql = `
            CREATE TABLE IF NOT EXISTS "${this.tableName}" (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )`.split('\n').map(l => l.trim()).join(' ')
            await this.db.rawSQL({q: sql, v: []}).run()
        }
    }

    async get<T = string>(key: string, field?: string) {
        const rnd = '_' + Math.random().toString(36).substring(7)
        const q = `SELECT (${field || 'value'}) as ${rnd} FROM ${this.tableName} WHERE key = ?`
        const res = await this.db.rawSQL<any>({q, v: [key]}).run()
        return res?.[0] ? res[0][rnd] as T : null
    }

    async get2<T>(key: string, ...fields: string[]) {
        const q = `SELECT value, ${fields.join(', ')} FROM ${this.tableName} WHERE key = ?`
        // const res = await this.db.prepare(q).bind(key).first()
        const res = await this.db.rawSQL<{ value: string } & T>({q, v: [key]}).run()
        return res?.[0] || null
    }

    async set(key: string, value: string | { sql: string }) {
        const s = typeof value !== 'string'
        const q = `INSERT OR REPLACE INTO ${this.tableName} (key, value) VALUES (?, ${s ? value.sql || "''" : "?"})`
        // console.log(q)
        const b = [key]
        if(!s) b.push(value)
        await this.db.rawSQL({q, v: b}).run()
    }
    async setSql(key: string, value: string) {
        return await this.set(key, {sql: value})
    }

}
