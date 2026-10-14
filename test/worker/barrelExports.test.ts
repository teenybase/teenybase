import {describe, expect, it} from 'vitest'

// teenybase/worker is the Workers entry: it exports WorkerEntrypoint classes (D1RestRPC, R2RestRPC) that
// import `cloudflare:workers`, so the barrel only loads in the Workers runtime. This used to live in the
// Node unit project, where it has failed since the RPC classes were added. Importing teenybase/worker
// from plain Node is tracked in issues/open/worker-barrel-imports-cloudflare-workers.md.
describe('barrel exports', () => {
    it('re-exports DefaultDatabaseAdapter from teenybase/worker', async () => {
        const worker = await import('../../src/worker')
        expect(typeof worker.DefaultDatabaseAdapter).toBe('function')
    })

    it('re-exports the RPC entrypoints used by project-gateway', async () => {
        const worker = await import('../../src/worker')
        expect(typeof worker.D1RestRPC).toBe('function')
        expect(typeof worker.R2RestRPC).toBe('function')
    })
})
