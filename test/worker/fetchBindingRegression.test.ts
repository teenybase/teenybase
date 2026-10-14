import {describe, expect, it} from 'vitest'
import {D1HttpAdapter} from '../../src/worker/storage/D1HttpAdapter'
import {D1RestAdapter} from '../../src/worker/storage/D1RestAdapter'
import {LibsqlAdapter} from '../../src/worker/storage/LibsqlAdapter'

/**
 * Regression guard for a bug caught by end-to-end testing: all three HTTP-based
 * adapters stored `this.fetchFn = opts.fetch ?? globalThis.fetch` and invoked it
 * as a method. In the real Cloudflare Workers runtime, `globalThis.fetch` is
 * "strict" — calling it as a method on anything other than globalThis throws
 * "Illegal invocation". Node's free-function fetch and vi.fn() mocks never
 * trigger this, so the existing unit tests missed it.
 *
 * These tests run inside the miniflare workerd pool (per test/worker/vitest.config.ts),
 * so the real workerd fetch is exercised. If someone reintroduces the bug by
 * dropping the `.bind(globalThis)` in any adapter's constructor, this file fails.
 *
 * We don't need a reachable server — we just need the fetch call to start. The
 * test passes if the error we get is a normal network/parse error, not
 * "Illegal invocation".
 */
describe('adapter fetch-binding regression', () => {
    const UNROUTABLE = 'http://127.0.0.1:1'   // will ECONNREFUSED without tripping any adapter precondition

    it('D1HttpAdapter.run does not throw "Illegal invocation" when using real globalThis.fetch', async () => {
        const a = new D1HttpAdapter({url: UNROUTABLE, authToken: 'x'})
        await expect(a.run('SELECT 1', [])).rejects.not.toThrow(/Illegal invocation/)
    })

    it('D1HttpAdapter.runBatch does not throw "Illegal invocation"', async () => {
        const a = new D1HttpAdapter({url: UNROUTABLE, authToken: 'x'})
        await expect(a.runBatch([{q: 'SELECT 1', v: []}])).rejects.not.toThrow(/Illegal invocation/)
    })

    it('D1RestAdapter.run does not throw "Illegal invocation"', async () => {
        const a = new D1RestAdapter({accountId: 'a', databaseId: 'b', apiToken: 't', baseUrl: UNROUTABLE})
        await expect(a.run('SELECT 1', [])).rejects.not.toThrow(/Illegal invocation/)
    })

    it('D1RestAdapter.runBatch does not throw "Illegal invocation"', async () => {
        const a = new D1RestAdapter({accountId: 'a', databaseId: 'b', apiToken: 't', baseUrl: UNROUTABLE})
        await expect(a.runBatch([{q: 'SELECT 1', v: []}])).rejects.not.toThrow(/Illegal invocation/)
    })

    it('LibsqlAdapter.run does not throw "Illegal invocation"', async () => {
        const a = new LibsqlAdapter({url: UNROUTABLE, authToken: 'x'})
        await expect(a.run('SELECT 1', [])).rejects.not.toThrow(/Illegal invocation/)
    })

    it('LibsqlAdapter.runBatch does not throw "Illegal invocation"', async () => {
        const a = new LibsqlAdapter({url: UNROUTABLE, authToken: 'x'})
        await expect(a.runBatch([{q: 'SELECT 1', v: []}])).rejects.not.toThrow(/Illegal invocation/)
    })
})
