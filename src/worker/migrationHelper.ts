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

    // Batched read: $settings (config JSON) + $settings_version (monotonic counter)
    // returned from a single D1 batch. Callers compute the `lastVersion` CAS token
    // they later pass to apply() from the `version` field here.
    async dbSettings(): Promise<{settings: DatabaseSettings | undefined, version: number | null}> {
        if (!this.db.auth.superadmin) throw new HTTPException(403, {message: 'Forbidden'})
        const res = await this.db.rawSQLTransaction<{value: string}>([
            this.kv.getQuery('$settings'),
            this.kv.getQuery('$settings_version'),
        ]).run() ?? [[], []]
        let settings: DatabaseSettings | undefined
        let version: number | null = null
        const sv = res[0]?.[0]?.value
        if (sv) { try { settings = JSON.parse(sv) as DatabaseSettings } catch {} }
        const vv = res[1]?.[0]?.value
        if (vv) { const n = parseInt(vv, 10); if (Number.isFinite(n)) version = n }
        return {settings, version}
    }

    async list() {
        if (!this.db.auth.superadmin) throw new HTTPException(403, {message: 'Forbidden'})
        const q = `SELECT id, name, sql, sql_revert FROM ${this.tableName}`
        return await this.db.rawSQL<DBMigration>({q, v: []}).run() || []
    }

    // settings optional: when omitted, apply only records migration rows (used by $Database.setup
    // to register infra migrations). When provided, `lastVersion` is the caller-supplied CAS
    // token fetched from dbSettings().version — null means "fresh DB, $settings_version doesn't
    // exist yet". Apply prepends a CAS statement that aborts the whole batch via SQLite's
    // malformed-JSON error if another apply already advanced the counter.
    async apply(
        migrations: Omit<DBMigration, 'id'>[],
        settings?: DatabaseSettings,
        lastVersion?: number | null,
    ) {
        if (!this.db.auth.superadmin) throw new HTTPException(403, {message: 'Forbidden'})
        const last = await this.list()
        const names: string[] = []
        const prepared = z.array(zDBMigration).parse(migrations).flatMap(m => {
            let last1 = last.find(r=>r.name === m.name)
            if(last1) {
                if (last1.sql !== m.sql) throw new Error(`Migration ${m.name} already applied but sql mismatch`)
                // Skip sql_revert check — revert SQL may not survive round-trip through file system
                // (readMigrationsFolder only reads sql, not sql_revert from files).
                return undefined
            }
            if(names.includes(m.name)) throw new Error(`Duplicate migration name ${m.name}`)
            names.push(m.name)
            const qs = splitSqlQuery(m.sql).map(sql => sql ? {q:sql, v:[]} : undefined).filter(q=>!!q) as D1Query[]
            if(!qs.length) throw new Error(`Empty migration ${m.name}`)
            return [
                ...qs, {
                    q: `INSERT INTO ${this.tableName} (name, sql, sql_revert, applied_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
                    v: [m.name, m.sql, m.sql_revert ?? null]
                }
            ]
        }).filter(q=>!!q) as D1Query[]
        if (settings) {
            if (lastVersion === undefined) throw new Error('apply: lastVersion is required when settings is provided (pass null for fresh DB)')
            const expectedVersion = (lastVersion ?? -1) + 1
            // Caller (CLI/route handler) is expected to stamp `version` so the deployed
            // worker bundle and the stored `$settings` blob carry the same value.
            if (settings.version !== expectedVersion) {
                throw new Error(`apply: settings.version must be ${expectedVersion} (= lastVersion + 1) but got ${settings.version}`)
            }
            const settings1 = JSON.stringify(settings)
            // CAS: first statement in the batch. If $settings_version has advanced since
            // the caller read it, the verify query raises "malformed JSON" and SQLite
            // aborts the whole batch — nothing commits.
            prepared.splice(0, 0,
                this.kv.casVerifyQuery('$settings_version', lastVersion),
                this.kv.setQuery('$settings', settings1),
            )
            prepared.push(this.kv.setQuery('$settings_'+Date.now(), settings1))
            prepared.push(this.kv.setQuery('$settings_version', String(settings.version)))
        }

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
            const {settings, version} = await this.dbSettings()
            return {migrations, settings: settings||this.db.settings, version}
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
                                version: z.number().nullable(),
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
            // Server stamps version so HTTP callers don't have to know the formula.
            const lastVersion = data.lastVersion ?? null
            const settings: DatabaseSettings = {...data.settings, version: (lastVersion ?? -1) + 1}
            const applied = await this.apply(data.migrations, settings, lastVersion)
            if (!applied) throw new HTTPException(500, {message: 'Unable to apply migrations'})
            return {applied}
        },
        zod: () => (<HttpRouteZod>{
            description: 'Apply migrations',
            request: {
                headers: z.object({authorization: z.string().min(1).max(255)}).describe('Admin Auth token with superadmin role'),
                body: {
                    description: 'All migrations, new DB settings, and the lastVersion CAS token (from GET /migrations). The batch aborts if $settings_version has advanced since the caller read it.',
                    content: {
                        'application/json': {
                            schema: z.object({
                                settings: databaseSettingsSchema,
                                migrations: z.array(zDBMigration),
                                lastVersion: z.number().nullable(),
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
