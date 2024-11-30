import {$Env, migrationsTable} from "./env";
import {Context, Hono} from 'hono'
import {HTTPException} from 'hono/http-exception'
import {parseRequestBody} from './util/parseRequestBody'
import {z} from 'zod'
import splitSqlQuery from './wrangler/d1/splitter'
import {D1PreparedStatement} from '@cloudflare/workers-types/2023-07-01/index'

export interface DBMigration{
    id: number
    name: string
    sql: string
    sql_revert?: string
}
const zDBMigration = z.object({
    name: z.string(),
    sql: z.string(),
    sql_revert: z.string().optional()
})

export class MigrationHelper {
    constructor(private db: D1Database, readonly tableName = '_ddb_migrations') {
    }

    async setup(version: number) {
        if (version >= 0) {
            const sql = `
            CREATE TABLE IF NOT EXISTS "${migrationsTable}" (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE,
                sql TEXT NOT NULL,
                sql_revert TEXT DEFAULT NULL,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
            )`.split('\n').map(l => l.trim()).join(' ')
            await this.db.exec(sql)
        }
    }

    async list() {
        const res = await this.db.prepare(`SELECT id, name, sql, sql_revert FROM ${migrationsTable}`).run<DBMigration>()
        return res.results
    }

    async apply(migrations: Omit<DBMigration, 'id'>[]) {
        const last = await this.list()
        const names: string[] = []
        const prepared = z.array(zDBMigration).parse(migrations).flatMap(m => {
            let last1 = last.find(r=>r.name === m.name)
            if(last1) {
                if (last1.sql !== m.sql) throw new Error(`Migration ${m.name} already applied but sql mismatch`)
                if ((last1.sql_revert||null) !== (m.sql_revert||null)) throw new Error(`Migration ${m.name} already applied but sql_revert mismatch`)
                return undefined
            }
            if(names.includes(m.name)) throw new Error(`Duplicate migration name ${m.name}`)
            names.push(m.name)
            // console.log(m.sql)
            const qs = splitSqlQuery(m.sql).map(sql => sql ? this.db.prepare(sql) : undefined).filter(q=>!!q) as D1PreparedStatement[]
            if(!qs.length) throw new Error(`Empty migration ${m.name}`)
            return [
                ...qs,
                this.db.prepare(`INSERT INTO ${migrationsTable} (name, sql, sql_revert)
                                 VALUES (?, ?, ?)`).bind(m.name, m.sql, m.sql_revert ?? null)
            ]
        }).filter(q=>!!q) as D1PreparedStatement[]
        if(!prepared.length) return []
        const res = await this.db.batch(prepared).catch(e => {
            throw new Error(`Failed to apply migrations: ${JSON.stringify(prepared)}`)
        })
        const success = res.every(r => r.success)
        if (!success) {
            const error = res.find(r => !r.success)?.error
            throw new Error(error || 'Failed to apply migrations')
        }
        return names
    }
}

export function setupMigrationRoutes<T extends $Env=$Env>(app: Hono<T>, base: string){
    app.get(base + '/migrations', async (c: Context<$Env>) => {
        if(!c.get('auth')?.admin) throw new HTTPException(403, {message: 'Forbidden'})
        const $db = c.get('$db')
        const migrations = await $db.migration?.list()
        return c.json({settings: $db.settings, migrations: migrations})
    })
    app.post(base + '/migrations', async (c: Context<$Env>) => {
        if(!c.get('auth')?.admin) throw new HTTPException(403, {message: 'Forbidden'})
        const $db = c.get('$db')
        const data = await parseRequestBody(c.req)
        // if(data.settings.version !== $db.settings.version){
        //     throw new HTTPException(400, {message: 'Settings version mismatch'})
        // }
        const migrations = await $db.migration?.apply(data.migrations)
        if(!migrations) throw new HTTPException(500, {message: 'Unable to apply migrations'})
        return c.json({applied: migrations} as any)
    })
}

