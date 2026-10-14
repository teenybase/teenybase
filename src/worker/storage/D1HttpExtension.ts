import type {$DBExtension} from '../$DBExtension'
import type {$Env} from '../env'
import type {HttpRoute} from '../../types/route'
import {DefaultDatabaseAdapter} from './DefaultDatabaseAdapter'
import {D1HttpAdapter} from './D1HttpAdapter'

/**
 * Registers a D1HttpAdapter into DefaultDatabaseAdapter when
 * settings.database.type === 'd1-http'. Register with:
 *
 *   await db.registerExtension(new D1HttpExtension(db))
 */
export class D1HttpExtension<T extends $Env = $Env> implements $DBExtension<T> {
    static readonly adapterType = 'd1-http'
    readonly routes: HttpRoute[] = []

    constructor(private readonly db: {
        settings: {database?: {type?: string, url?: string, authToken?: string}}
        adapter: unknown
        secretResolver: {resolve: (s: string) => Promise<string>}
    }) {}

    async init(): Promise<void> {
        const cfg = this.db.settings.database
        if (cfg?.type !== D1HttpExtension.adapterType) return
        const adapter = this.db.adapter
        if (!(adapter instanceof DefaultDatabaseAdapter)) return

        if (!cfg.url) throw new Error('D1HttpExtension: settings.database.url is required for type="d1-http"')

        const url = await this.db.secretResolver.resolve(cfg.url)
        const authToken = cfg.authToken ? await this.db.secretResolver.resolve(cfg.authToken) : undefined

        adapter.registerDelegate(D1HttpExtension.adapterType, new D1HttpAdapter({url, authToken}))
    }
}
