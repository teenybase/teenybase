import {describe, expect, it} from 'vitest'
import {D1HttpExtension} from '../../src/worker/storage/D1HttpExtension'
import {D1HttpAdapter} from '../../src/worker/storage/D1HttpAdapter'
import {DefaultDatabaseAdapter} from '../../src/worker/storage/DefaultDatabaseAdapter'
import type {DatabaseConfig} from '../../src/types/config'

function fakeDb(config: DatabaseConfig | undefined, adapter: any) {
    return {
        settings: {database: config},
        adapter,
        secretResolver: {resolve: async (s: string) => s.startsWith('$') ? `resolved-${s.slice(1)}` : s},
    } as any
}

describe('D1HttpExtension', () => {
    it('static adapterType is "d1-http"', () => { expect(D1HttpExtension.adapterType).toBe('d1-http') })

    it('no-ops when type is not d1-http', async () => {
        const adapter = new DefaultDatabaseAdapter({type: 'd1-binding', binding: 'DB'}, {})
        const ext = new D1HttpExtension(fakeDb({type: 'd1-binding', binding: 'DB'}, adapter))
        await ext.init()
        expect((adapter as any).delegates.size).toBe(0)
    })

    it('no-ops when adapter is not DefaultDatabaseAdapter', async () => {
        const ext = new D1HttpExtension(fakeDb(
            {type: 'd1-http', url: 'https://x', authToken: 't'},
            {run: async () => ({success: true, results: []}), runBatch: async () => []},
        ))
        await expect(ext.init()).resolves.toBeUndefined()
    })

    it('rejects missing url', async () => {
        const config: DatabaseConfig = {type: 'd1-http'}
        const adapter = new DefaultDatabaseAdapter(config, {})
        const ext = new D1HttpExtension(fakeDb(config, adapter))
        await expect(ext.init()).rejects.toThrow(/url/)
    })

    it('resolves $-prefixed secrets and registers a D1HttpAdapter delegate', async () => {
        const config: DatabaseConfig = {type: 'd1-http', url: '$SQLITE_URL', authToken: '$SQLITE_TOKEN'}
        const adapter = new DefaultDatabaseAdapter(config, {})
        const ext = new D1HttpExtension(fakeDb(config, adapter))
        await ext.init()
        const delegate = (adapter as any).delegates.get('d1-http')
        expect(delegate).toBeInstanceOf(D1HttpAdapter)
        expect((delegate as any).base).toBe('resolved-SQLITE_URL')
        expect((delegate as any).headers['Authorization']).toBe('Bearer resolved-SQLITE_TOKEN')
    })

    it('allows omitted authToken for dev servers', async () => {
        const config: DatabaseConfig = {type: 'd1-http', url: 'http://localhost:3000'}
        const adapter = new DefaultDatabaseAdapter(config, {})
        const ext = new D1HttpExtension(fakeDb(config, adapter))
        await ext.init()
        const delegate = (adapter as any).delegates.get('d1-http') as D1HttpAdapter
        expect(delegate).toBeInstanceOf(D1HttpAdapter)
        expect((delegate as any).headers['Authorization']).toBeUndefined()
    })

    it('has an empty routes array', () => {
        const adapter = new DefaultDatabaseAdapter(undefined, {})
        const ext = new D1HttpExtension(fakeDb(undefined, adapter))
        expect(ext.routes).toEqual([])
    })
})
