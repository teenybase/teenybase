import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'
import {D1RestExtension} from '../../src/worker/storage/D1RestExtension'
import {D1RestAdapter} from '../../src/worker/storage/D1RestAdapter'
import {DefaultDatabaseAdapter} from '../../src/worker/storage/DefaultDatabaseAdapter'
import type {DatabaseConfig} from '../../src/types/config'

function fakeDb(config: DatabaseConfig | undefined, adapter: any) {
    return {
        settings: {database: config},
        adapter,
        secretResolver: {resolve: async (s: string) => s.startsWith('$') ? `resolved-${s.slice(1)}` : s},
    } as any
}

describe('D1RestExtension', () => {
    let fetchMock: any
    beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

    it('static adapterType is "d1-rest"', () => {
        expect(D1RestExtension.adapterType).toBe('d1-rest')
    })

    it('no-ops when settings.database.type is not d1-rest', async () => {
        const adapter = new DefaultDatabaseAdapter({type: 'd1-binding', binding: 'DB'}, {})
        const ext = new D1RestExtension(fakeDb({type: 'd1-binding', binding: 'DB'}, adapter))
        await ext.init()
        // adapter should have no delegate registered
        expect((adapter as any).delegates.size).toBe(0)
    })

    it('no-ops when adapter is not DefaultDatabaseAdapter', async () => {
        const ext = new D1RestExtension(fakeDb(
            {type: 'd1-rest', cloudflare: {accountId: 'A', databaseId: 'B', apiToken: 'T'}},
            {run: async () => ({success: true, results: []}), runBatch: async () => []},
        ))
        await expect(ext.init()).resolves.toBeUndefined()
    })

    it('resolves $-prefixed secrets and registers a D1RestAdapter delegate', async () => {
        const config: DatabaseConfig = {
            type: 'd1-rest',
            cloudflare: {accountId: '$CF_ACCT', databaseId: '$D1_ID', apiToken: '$CF_TOK'},
        }
        const adapter = new DefaultDatabaseAdapter(config, {})
        const ext = new D1RestExtension(fakeDb(config, adapter))
        await ext.init()
        const delegate = (adapter as any).delegates.get('d1-rest')
        expect(delegate).toBeInstanceOf(D1RestAdapter)
        // check that the registered adapter has resolved creds (spot-check URL construction)
        expect((delegate as any).url).toContain('resolved-CF_ACCT')
        expect((delegate as any).url).toContain('resolved-D1_ID')
    })

    it('rejects incomplete cloudflare credentials', async () => {
        const config: DatabaseConfig = {type: 'd1-rest', cloudflare: {accountId: 'A'}}
        const adapter = new DefaultDatabaseAdapter(config, {})
        const ext = new D1RestExtension(fakeDb(config, adapter))
        await expect(ext.init()).rejects.toThrow(/databaseId|apiToken/)
    })

    it('has an empty routes array (not a route-contributing extension)', () => {
        const adapter = new DefaultDatabaseAdapter(undefined, {})
        const ext = new D1RestExtension(fakeDb(undefined, adapter))
        expect(ext.routes).toEqual([])
    })
})
