import {describe, expect, it} from 'vitest'
import {$Database, D1Adapter} from '../../src/worker'
import type {$DBExtension} from '../../src/worker/$DBExtension'
import type {HttpRoute} from '../../src/types/route'
import {env, createExecutionContext} from 'cloudflare:test'
import {Hono} from 'hono'

// Minimal settings; populated inside the test via setupConfig if needed. For this
// test we only exercise registerExtension lifecycle, no queries are issued.
const minimalSettings = {
    tables: [],
    jwtSecret: 'test-secret',
    appUrl: 'http://localhost',
}

function makeDb() {
    const app = new Hono()
    const ctx = createExecutionContext()
    const c: any = {
        env,
        executionCtx: ctx,
        req: {header: () => undefined, url: 'http://localhost/'},
        set: () => {},
        get: () => undefined,
    }
    return new $Database<any>(c, minimalSettings as any, new D1Adapter(env.PRIMARY_DB), env.PRIMARY_R2)
}

class TrackingExtension implements $DBExtension<any> {
    routes: HttpRoute[] = []
    initCalls = 0
    initResolved = false

    async init() {
        this.initCalls++
        await new Promise(r => setTimeout(r, 5))
        this.initResolved = true
    }
}

class NoInitExtension implements $DBExtension<any> {
    routes: HttpRoute[] = []
}

describe('$Database.registerExtension', () => {
    it('pushes the extension into db.extensions', async () => {
        const db = makeDb()
        const before = db.extensions.length
        const ext = new NoInitExtension()
        await db.registerExtension(ext)
        expect(db.extensions.length).toBe(before + 1)
        expect(db.extensions[db.extensions.length - 1]).toBe(ext)
    })

    it('returns the extension (for chaining / direct use)', async () => {
        const db = makeDb()
        const ext = new NoInitExtension()
        const returned = await db.registerExtension(ext)
        expect(returned).toBe(ext)
    })

    it('invokes init() exactly once', async () => {
        const db = makeDb()
        const ext = new TrackingExtension()
        await db.registerExtension(ext)
        expect(ext.initCalls).toBe(1)
    })

    it('awaits async init before resolving', async () => {
        const db = makeDb()
        const ext = new TrackingExtension()
        await db.registerExtension(ext)
        expect(ext.initResolved).toBe(true)
    })

    it('works for extensions that have no init()', async () => {
        const db = makeDb()
        const ext = new NoInitExtension()
        await expect(db.registerExtension(ext)).resolves.toBe(ext)
    })

    it('propagates errors thrown inside init()', async () => {
        const db = makeDb()
        class BadExt implements $DBExtension<any> {
            routes: HttpRoute[] = []
            async init() { throw new Error('boom') }
        }
        await expect(db.registerExtension(new BadExt())).rejects.toThrow('boom')
    })
})
