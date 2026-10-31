import {afterEach, describe, expect, test, vi} from 'vitest'
import {$Database} from '../../src/worker/$Database'

// Minimal Hono-like context: $Database only reads env, request headers and the auth/settings slots here.
function makeDb(env: Record<string, string | undefined>) {
    const vars = new Map<string, any>()
    const c: any = {
        env: {ADMIN_JWT_SECRET: 'test-admin-jwt-secret-value', ...env},
        req: {header: () => undefined},
        set: (k: string, v: any) => vars.set(k, v),
        get: (k: string) => vars.get(k),
    }
    const d1: any = {prepare: () => { throw new Error('no queries in this test') }}
    return new $Database(c, {tables: [], appUrl: 'https://app.example.com', jwtSecret: 'x'} as any, d1)
}

afterEach(() => { vi.restoreAllMocks() })

describe('ADMIN_SERVICE_TOKEN', () => {
    test.each([
        ['unset', undefined],
        ['empty', ''],
        ['the placeholder not-set', 'not-set'],
        ['NOT-SET with spaces', '  NOT-SET '],
    ])('%s counts as not set: no superadmin token for it', async (_label, value) => {
        const db = makeDb({ADMIN_SERVICE_TOKEN: value})
        expect(await db.adminServiceToken()).toBe('')
        await expect(db.generateAdminToken('superadmin', value ?? '')).rejects.toMatchObject({status: 401})
        await expect(db.generateAdminToken('superadmin', 'not-set')).rejects.toMatchObject({status: 401})
    })

    test('a real token is accepted and issues an admin token', async () => {
        const db = makeDb({ADMIN_SERVICE_TOKEN: 'a-long-random-admin-token-1234'})
        expect(await db.adminServiceToken()).toBe('a-long-random-admin-token-1234')
        await expect(db.generateAdminToken('superadmin', 'a-long-random-admin-token-1234')).resolves.toEqual(expect.any(String))
        await expect(db.generateAdminToken('superadmin', 'wrong')).rejects.toMatchObject({status: 401})
    })

    test('a token shorter than 12 characters still works but logs an error once', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {})
        const db = makeDb({ADMIN_SERVICE_TOKEN: 'short-tok'})
        expect(await db.adminServiceToken()).toBe('short-tok')
        await db.adminServiceToken()
        await makeDb({ADMIN_SERVICE_TOKEN: 'short-tok'}).adminServiceToken()
        expect(err).toHaveBeenCalledTimes(1)
        expect(String(err.mock.calls[0][0])).toContain('shorter than 12 characters')
    })
})
