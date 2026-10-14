import {describe, expect, it} from 'vitest'
import {databaseConfigSchema} from '../src/types/zod/databaseSettingsSchema'

describe('databaseConfigSchema', () => {
    describe('type: d1-binding', () => {
        it('accepts {type, binding}', () => {
            const r = databaseConfigSchema.safeParse({type: 'd1-binding', binding: 'PRIMARY_DB'})
            expect(r.success).toBe(true)
        })

        it('rejects missing binding', () => {
            const r = databaseConfigSchema.safeParse({type: 'd1-binding'})
            expect(r.success).toBe(false)
            if (!r.success) {
                expect(r.error.issues.some(i => i.path.includes('binding'))).toBe(true)
            }
        })
    })

    describe('type: libsql', () => {
        it('accepts {type, url}', () => {
            const r = databaseConfigSchema.safeParse({type: 'libsql', url: 'libsql://example.turso.io'})
            expect(r.success).toBe(true)
        })

        it('accepts {type, url, authToken}', () => {
            const r = databaseConfigSchema.safeParse({
                type: 'libsql', url: '$TURSO_URL', authToken: '$TURSO_TOKEN',
            })
            expect(r.success).toBe(true)
        })

        it('rejects missing url', () => {
            const r = databaseConfigSchema.safeParse({type: 'libsql'})
            expect(r.success).toBe(false)
            if (!r.success) {
                expect(r.error.issues.some(i => i.path.includes('url'))).toBe(true)
            }
        })
    })

    describe('type: d1-http', () => {
        it('rejects missing url', () => {
            const r = databaseConfigSchema.safeParse({type: 'd1-http'})
            expect(r.success).toBe(false)
        })

        it('accepts {type, url, authToken}', () => {
            const r = databaseConfigSchema.safeParse({
                type: 'd1-http', url: 'https://db.example.com', authToken: 'secret',
            })
            expect(r.success).toBe(true)
        })
    })

    describe('type: d1-rest', () => {
        it('accepts full cloudflare credentials', () => {
            const r = databaseConfigSchema.safeParse({
                type: 'd1-rest',
                cloudflare: {accountId: 'a', databaseId: 'b', apiToken: 'c'},
            })
            expect(r.success).toBe(true)
        })

        it('rejects missing accountId', () => {
            const r = databaseConfigSchema.safeParse({
                type: 'd1-rest',
                cloudflare: {databaseId: 'b', apiToken: 'c'},
            })
            expect(r.success).toBe(false)
            if (!r.success) {
                expect(r.error.issues.some(i =>
                    i.path.length === 2 && i.path[0] === 'cloudflare' && i.path[1] === 'accountId'
                )).toBe(true)
            }
        })

        it('rejects missing databaseId', () => {
            const r = databaseConfigSchema.safeParse({
                type: 'd1-rest',
                cloudflare: {accountId: 'a', apiToken: 'c'},
            })
            expect(r.success).toBe(false)
        })

        it('rejects missing apiToken', () => {
            const r = databaseConfigSchema.safeParse({
                type: 'd1-rest',
                cloudflare: {accountId: 'a', databaseId: 'b'},
            })
            expect(r.success).toBe(false)
        })

        it('rejects missing cloudflare object', () => {
            const r = databaseConfigSchema.safeParse({type: 'd1-rest'})
            expect(r.success).toBe(false)
        })
    })

    describe('custom type', () => {
        it('accepts unknown type with no fields (extension is responsible for its own validation)', () => {
            const r = databaseConfigSchema.safeParse({type: 'my-custom-adapter'})
            expect(r.success).toBe(true)
        })

        it('accepts unknown type with arbitrary extra fields (passthrough)', () => {
            const r = databaseConfigSchema.safeParse({
                type: 'my-custom-adapter', host: 'localhost', port: 5432,
            })
            expect(r.success).toBe(true)
            if (r.success) {
                expect((r.data as any).host).toBe('localhost')
            }
        })
    })

    describe('base validation', () => {
        it('rejects missing type', () => {
            const r = databaseConfigSchema.safeParse({binding: 'PRIMARY_DB'})
            expect(r.success).toBe(false)
        })

        it('rejects empty type string', () => {
            const r = databaseConfigSchema.safeParse({type: ''})
            expect(r.success).toBe(false)
        })
    })
})
