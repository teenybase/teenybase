import {HTTPException} from 'hono/http-exception'
import {z} from 'zod'
import {splitSqlQuery} from './wrangler/d1/splitter'
import {DatabaseSettings} from '../types/config'
import {type $Database} from './$Database'
import {HttpRoute, HttpRouteZod} from '../types/route'
import {D1Query} from '../sql/build/d1'
import {$Env} from './env'
import {databaseSettingsSchema} from '../types/zod/databaseSettingsSchema';
import {$DBExtension} from './$DBExtension'
import {InternalKV} from './internalKV'
import {$DatabaseRaw} from './$DatabaseRawImpl'

export interface DBMigration{
    id: number
    name: string
    sql: string
    sql_revert?: string
}
export const zDBMigration = z.object({
    name: z.string().max(255),
    sql: z.string().max(65535),
    sql_revert: z.string().max(65535).optional()
})

export class MigrationHelperRaw<T extends $DatabaseRaw = $DatabaseRaw>{
    static readonly DEFAULT_TABLE_NAME = '_db_migrations'

    constructor(readonly db: T, private readonly kv: InternalKV, readonly tableName = MigrationHelperRaw.DEFAULT_TABLE_NAME) {
    }

    async setup(version: number) {
        if (!this.db.auth.superadmin) throw new HTTPException(403, {message: 'Forbidden'})
        if (version >= 0) {
            const sql = `
            CREATE TABLE IF NOT EXISTS "${this.tableName}" (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE,
                sql TEXT NOT NULL,
                sql_revert TEXT DEFAULT NULL,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
            )`.split('\n').map(l => l.trim()).join(' ')
            // await this.db.database.exec(sql)
            await this.db.rawSQL({q: sql, v: []}).run()
        }
    }

    async dbSettings(){
        if (!this.db.auth.superadmin) throw new HTTPException(403, {message: 'Forbidden'})
        const settings = await this.kv.get('$settings')
        return settings ? JSON.parse(settings) as DatabaseSettings : undefined
    }

    async list() {
        if (!this.db.auth.superadmin) throw new HTTPException(403, {message: 'Forbidden'})
        const q = `SELECT id, name, sql, sql_revert FROM ${this.tableName}`
        // const res = await this.db.database.prepare(q).run<DBMigration>()
        return await this.db.rawSQL<DBMigration>({q, v: []}).run() || []
    }

    async apply(migrations: Omit<DBMigration, 'id'>[], settings: DatabaseSettings) {
        if (!this.db.auth.superadmin) throw new HTTPException(403, {message: 'Forbidden'})
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
            const qs = splitSqlQuery(m.sql).map(sql => sql ? {q:sql, v:[]} : undefined).filter(q=>!!q) as D1Query[]
            if(!qs.length) throw new Error(`Empty migration ${m.name}`)
            return [
                ...qs, {
                    q: `INSERT INTO ${this.tableName} (name, sql, sql_revert, applied_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
                    v: [m.name, m.sql, m.sql_revert ?? null]
                }
            ]
        }).filter(q=>!!q) as D1Query[]
        const settings1 = JSON.stringify(settings)
        prepared.push(this.kv.setQuery('$settings', settings1))
        prepared.push(this.kv.setQuery('$settings_'+Date.now(), settings1))
        prepared.push(this.kv.setQuery('$settings_version', settings.version?.toString() ?? '0'))

        if(!prepared.length) return []
        try {
            await this.db.rawSQLTransaction(prepared).run()
        }catch (e){
            throw e??new Error('Failed to apply migrations')
        }
        return names
    }

}

export class MigrationHelper<T extends $Env = $Env> extends MigrationHelperRaw<$Database<T>> implements $DBExtension<T>{
    constructor(db: $Database<T>, kv: InternalKV, tableName?: string) {
        super(db, kv, tableName)
    }

    async getAuthToken?(): Promise<string | undefined>

    routes: HttpRoute[] = [{
        path: '/migrations',
        method: 'get',
        handler: async () => {
            const migrations = await this.list()
            const settings = await this.dbSettings()
            return {migrations, settings: settings||this.db.settings}
        },
        zod: () => (<HttpRouteZod>{
            description: 'List all migrations',
            request: {headers: z.object({authorization: z.string().min(1).max(255)}).describe('Admin Auth token with superadmin role')},
            responses: {
                '200': {
                    description: 'Success',
                    content: {
                        'application/json': {
                            schema: z.object({
                                settings: databaseSettingsSchema,
                                migrations: z.array(zDBMigration),
                            }),
                        }
                    },
                }
            },
        }),
    }, {
        path: '/migrations',
        method: 'post',
        handler: async (data) => {
            // if(this.db.settings.version && data.settings.version !== this.db.settings.version){
            //     throw new HTTPException(400, {message: 'Settings version mismatch'})
            // }
            const migrations = await this.apply(data.migrations, data.settings)
            if (!migrations) throw new HTTPException(500, {message: 'Unable to apply migrations'})
            return {applied: migrations}
        },
        zod: () => (<HttpRouteZod>{
            description: 'Apply migrations',
            request: {
                headers: z.object({authorization: z.string().min(1).max(255)}).describe('Admin Auth token with superadmin role'),
                body: {
                    description: 'All migrations and new DB settings. New migrations will be applied and old migrations will be checked for db match',
                    content: {
                        'application/json': {
                            schema: z.object({
                                settings: databaseSettingsSchema,
                                migrations: z.array(zDBMigration),
                            }),
                        }
                    },
                    required: true,
                },
            },
            responses: {
                '200': {
                    description: 'Success',
                    content: {
                        'application/json': {
                            schema: z.object({
                                applied: z.array(z.string()),
                            }),
                        }
                    },
                }
            },
        }),
    }]

}
