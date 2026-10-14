import {describe, expect, it} from 'vitest'
import {LibsqlExtension} from '../../src/worker/storage/LibsqlExtension'
import {LibsqlAdapter} from '../../src/worker/storage/LibsqlAdapter'
import {DefaultDatabaseAdapter} from '../../src/worker/storage/DefaultDatabaseAdapter'
import type {DatabaseConfig} from '../../src/types/config'

function fakeDb(config: DatabaseConfig | undefined, adapter: any) {
    return {
        settings: {database: config},
        adapter,
        secretResolver: {resolve: async (s: string) => s.startsWith('$') ? `resolved-${s.slice(1)}` : s},
    } as any
}

describe('LibsqlExtension', () => {
    it('static adapterType is "libsql"', () => {
        expect(LibsqlExtension.adapterType).toBe('libsql')
    })

    it('no-ops when type is not libsql', async () => {
        const adapter = new DefaultDatabaseAdapter({type: 'd1-binding', binding: 'DB'}, {})
        const ext = new LibsqlExtension(fakeDb({type: 'd1-binding', binding: 'DB'}, adapter))
        await ext.init()
        expect((adapter as any).delegates.size).toBe(0)
    })

    it('no-ops when adapter is not DefaultDatabaseAdapter', async () => {
        const ext = new LibsqlExtension(fakeDb(
            {type: 'libsql', url: 'https://x', authToken: 't'},
            {run: async () => ({success: true, results: []}), runBatch: async () => []},
        ))
        await expect(ext.init()).resolves.toBeUndefined()
    })

    it('rejects missing url', async () => {
        const config: DatabaseConfig = {type: 'libsql'}
        const adapter = new DefaultDatabaseAdapter(config, {})
        const ext = new LibsqlExtension(fakeDb(config, adapter))
        await expect(ext.init()).rejects.toThrow(/url/)
    })

    it('resolves $-prefixed secrets and registers a LibsqlAdapter delegate', async () => {
        const config: DatabaseConfig = {type: 'libsql', url: '$TURSO_URL', authToken: '$TURSO_TOKEN'}
        const adapter = new DefaultDatabaseAdapter(config, {})
        const ext = new LibsqlExtension(fakeDb(config, adapter))
        await ext.init()
        const delegate = (adapter as any).delegates.get('libsql')
        expect(delegate).toBeInstanceOf(LibsqlAdapter)
        expect((delegate as any).url).toContain('resolved-TURSO_URL')
        expect((delegate as any).headers['Authorization']).toBe('Bearer resolved-TURSO_TOKEN')
    })

    it('allows omitted authToken for local/unauthenticated servers', async () => {
        const config: DatabaseConfig = {type: 'libsql', url: 'http://localhost:8080'}
        const adapter = new DefaultDatabaseAdapter(config, {})
        const ext = new LibsqlExtension(fakeDb(config, adapter))
        await ext.init()
        const delegate = (adapter as any).delegates.get('libsql') as LibsqlAdapter
        expect(delegate).toBeInstanceOf(LibsqlAdapter)
        expect((delegate as any).headers['Authorization']).toBeUndefined()
    })

    it('has an empty routes array', () => {
        const adapter = new DefaultDatabaseAdapter(undefined, {})
        const ext = new LibsqlExtension(fakeDb(undefined, adapter))
        expect(ext.routes).toEqual([])
    })
})
