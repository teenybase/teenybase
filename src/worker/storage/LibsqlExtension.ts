import type {$DBExtension} from '../$DBExtension'
import type {$Env} from '../env'
import type {HttpRoute} from '../../types/route'
import {DefaultDatabaseAdapter} from './DefaultDatabaseAdapter'
import {LibsqlAdapter} from './LibsqlAdapter'

/**
 * Registers a LibsqlAdapter delegate into DefaultDatabaseAdapter when
 * settings.database.type === 'libsql'. Register with:
 *
 *   await db.registerExtension(new LibsqlExtension(db))
 */
export class LibsqlExtension<T extends $Env = $Env> implements $DBExtension<T> {
    static readonly adapterType = 'libsql'
    readonly routes: HttpRoute[] = []

    constructor(private readonly db: {
        settings: {database?: {type?: string, url?: string, authToken?: string}}
        adapter: unknown
        secretResolver: {resolve: (s: string) => Promise<string>}
    }) {}

    async init(): Promise<void> {
        const cfg = this.db.settings.database
        if (cfg?.type !== LibsqlExtension.adapterType) return
        const adapter = this.db.adapter
        if (!(adapter instanceof DefaultDatabaseAdapter)) return

        if (!cfg.url) throw new Error('LibsqlExtension: settings.database.url is required for type="libsql"')

        const url = await this.db.secretResolver.resolve(cfg.url)
        const authToken = cfg.authToken ? await this.db.secretResolver.resolve(cfg.authToken) : undefined

        adapter.registerDelegate(LibsqlExtension.adapterType, new LibsqlAdapter({url, authToken}))
    }
}
