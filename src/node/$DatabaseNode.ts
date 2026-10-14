import {$DatabaseRawImpl} from '../worker/$DatabaseRawImpl'
import {StorageAdapter} from '../worker/storage/StorageAdapter'
import {InternalKV} from '../worker/internalKV'
import {InternalIdentities} from '../worker/InternalIdentities'
import {DBMigration, MigrationHelperRaw} from '../worker/migrationHelper'
import {DatabaseSettings, hasIdentitiesExtension} from '../types/config'

/**
 * Node.js-side database for CLI operations (setup, migrations, reading settings)
 * without requiring a Hono Context or worker runtime.
 */
export class $DatabaseNode extends $DatabaseRawImpl {
    readonly settings: DatabaseSettings
    readonly kv: InternalKV
    readonly identities: InternalIdentities | null
    readonly migrationHelper: MigrationHelperRaw

    constructor(settings: DatabaseSettings, adapter: StorageAdapter | D1Database) {
        super(adapter)
        this.auth.superadmin = true
        this.settings = settings
        this.kv = new InternalKV(this, this.settings._kvTableName)
        this.identities = hasIdentitiesExtension(settings) ? new InternalIdentities(this) : null
        this.migrationHelper = new MigrationHelperRaw(this, this.kv, undefined) // todo migration table name is fixed
    }

    /**
     * Create metadata tables and record infra creations in _db_migrations so the DB is
     * replayable by sorting _db_migrations SQL in id order on a fresh DB.
     * Mirrors $Database.setup() — MigrationHelperRaw.setup returns void (circular), infra
     * entries from kv/identities get recorded via migrationHelper.apply (no settings,
     * so $settings is untouched). See $Database.setup() for the fail-fast rationale.
     */
    async setup(): Promise<string> {
        // Thunk form so sync throws from a setup call land in the same catch as async rejections.
        const tag = <V>(source: string, thunk: () => Promise<V> | V): Promise<V> =>
            Promise.resolve().then(thunk).catch((e: unknown) => {
                const err = e instanceof Error ? e : new Error(String(e))
                err.message = `[setup:${source}] ${err.message}`
                throw err
            })
        const results = await Promise.all<Omit<DBMigration, 'id'> | null | void>([
            tag('kv', () => this.kv.setup(0)),
            tag('migrationHelper', () => this.migrationHelper.setup(0)),
            tag('identities', () => this.identities?.setup(0) ?? null),
        ])
        const infraEntries = results.filter(
            (r): r is Omit<DBMigration, 'id'> =>
                !!r && typeof r === 'object' && 'name' in r && 'sql' in r
        )
        if (infraEntries.length) {
            try {
                await this.migrationHelper.apply(infraEntries)
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                throw new Error(`[setup:record-infra] Infra tables created but recording into _db_migrations failed: ${msg}. Retry Setup — idempotent.`)
            }
        }
        const settings = await this.kv.get('$settings')
        if (!settings) {
            return 'Migrations not run yet - $settings not found - Run migrations to update $settings in the db'
        }
        const parsed = JSON.parse(settings)
        if (parsed.version !== this.settings.version) {
            return `Settings version mismatch - ${parsed.version} !== ${this.settings.version} - deploy the worker again with the latest settings`
        }
        return 'Success'
    }

}
