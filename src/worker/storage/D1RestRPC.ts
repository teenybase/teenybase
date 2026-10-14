// D1RestRPC — WorkerEntrypoint wrapping D1RestAdapter for cross-isolate use
// under LOADER. The managed backend forwards D1 queries to user project
// databases through this entrypoint; LOADER can't serialize class instances,
// so we reconstruct the adapter from props on the receiving side.
//
// Props are passed at call time:
// `exports.D1RestRPC({ props: { accountId, databaseId, apiToken } })`
// Each project gets its own databaseId — props must be per-project.

import {WorkerEntrypoint} from 'cloudflare:workers'
import {D1RestAdapter} from './D1RestAdapter'
import type {QueryResult} from './StorageAdapter'

export interface D1RestRPCProps {
    accountId: string
    databaseId: string
    apiToken: string
    baseUrl?: string
}

export class D1RestRPC extends WorkerEntrypoint<{}, D1RestRPCProps> {
    private _adapter: D1RestAdapter | null = null

    private adapter(): D1RestAdapter {
        if (this._adapter) return this._adapter
        const props = this.ctx.props
        if (!props || typeof props.accountId !== 'string') {
            throw new Error('D1RestRPC: missing or invalid props (need accountId, databaseId, apiToken)')
        }
        this._adapter = new D1RestAdapter({
            accountId: props.accountId,
            databaseId: props.databaseId,
            apiToken: props.apiToken,
            baseUrl: props.baseUrl,
        })
        return this._adapter
    }

    async run<T = unknown>(q: string, v: readonly any[]): Promise<QueryResult<T>> {
        return this.adapter().run<T>(q, v)
    }

    async runBatch<T = unknown>(
        queries: {q: string; v: readonly any[]}[]
    ): Promise<QueryResult<T>[]> {
        return this.adapter().runBatch<T>(queries)
    }
}
