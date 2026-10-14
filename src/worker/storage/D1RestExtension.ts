import type {$DBExtension} from '../$DBExtension'
import type {$Env} from '../env'
import type {HttpRoute} from '../../types/route'
import {DefaultDatabaseAdapter} from './DefaultDatabaseAdapter'
import {D1RestAdapter} from './D1RestAdapter'

/**
 * Wires a D1RestAdapter into DefaultDatabaseAdapter when
 * settings.database.type === 'd1-rest'. Register with:
 *
 *   await db.registerExtension(new D1RestExtension(db))
 *
 * Silently no-ops when the configured type is different, or when the user
 * supplied their own (non-Default) adapter — the registration is irrelevant
 * in those cases.
 */
export class D1RestExtension<T extends $Env = $Env> implements $DBExtension<T> {
    static readonly adapterType = 'd1-rest'
    readonly routes: HttpRoute[] = []

    constructor(private readonly db: {
        settings: {database?: {type?: string, cloudflare?: {accountId?: string, databaseId?: string, apiToken?: string}}}
        adapter: unknown
        secretResolver: {resolve: (s: string) => Promise<string>}
    }) {}

    async init(): Promise<void> {
        const cfg = this.db.settings.database
        if (cfg?.type !== D1RestExtension.adapterType) return
        const adapter = this.db.adapter
        if (!(adapter instanceof DefaultDatabaseAdapter)) return

        const cf = cfg.cloudflare ?? {}
        if (!cf.accountId || !cf.databaseId || !cf.apiToken) {
            const missing = ['accountId', 'databaseId', 'apiToken'].filter(f => !(cf as any)[f])
            throw new Error(`D1RestExtension: settings.database.cloudflare.{${missing.join(',')}} required for type="d1-rest"`)
        }

        const [accountId, databaseId, apiToken] = await Promise.all([
            this.db.secretResolver.resolve(cf.accountId),
            this.db.secretResolver.resolve(cf.databaseId),
            this.db.secretResolver.resolve(cf.apiToken),
        ])

        adapter.registerDelegate(D1RestExtension.adapterType, new D1RestAdapter({accountId, databaseId, apiToken}))
    }
}
