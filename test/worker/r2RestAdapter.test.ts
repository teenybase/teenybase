import {describe, expect, it, vi} from 'vitest'
import {env} from 'cloudflare:test'
import {R2RestAdapter} from '../../src/worker/storage/R2RestAdapter'
import {$Database} from '../../src/worker/$Database'

// $Database deletes uploaded files with an array of keys (deleteFileObject → bucket.delete(keys)),
// the same as R2Bucket.delete accepts. The REST adapter used to take a single string only and
// failed with "key.split is not a function", which surfaced as "Failed to delete files" on every
// file-field insert through an RPC bucket (R2RestRPC).
function adapter(fetchFn: typeof fetch) {
    return new R2RestAdapter({accountId: 'ACC', bucket: 'bkt', accessKeyId: 'AK', secretAccessKey: 'SK', fetch: fetchFn})
}

describe('R2RestAdapter.delete', () => {
    it('deletes every key when given an array', async () => {
        const fetchMock = vi.fn(async () => new Response(null, {status: 204}))
        await adapter(fetchMock as unknown as typeof fetch).delete(['assets/a_x1.js', 'assets/b_y2.glb'])
        expect(fetchMock).toHaveBeenCalledTimes(2)
        const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
        expect(calls.map(([, init]) => init.method)).toEqual(['DELETE', 'DELETE'])
        expect(calls.map(([url]) => url).sort()).toEqual([
            'https://ACC.r2.cloudflarestorage.com/bkt/assets/a_x1.js',
            'https://ACC.r2.cloudflarestorage.com/bkt/assets/b_y2.glb',
        ])
    })

    it('still deletes a single key', async () => {
        const fetchMock = vi.fn(async () => new Response(null, {status: 204}))
        await adapter(fetchMock as unknown as typeof fetch).delete('assets/a_x1.js')
        expect(fetchMock).toHaveBeenCalledOnce()
        const [url, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]
        expect(url).toBe('https://ACC.r2.cloudflarestorage.com/bkt/assets/a_x1.js')
        expect(init.method).toBe('DELETE')
    })

    it('makes no request for an empty array', async () => {
        const fetchMock = vi.fn(async () => new Response(null, {status: 204}))
        await adapter(fetchMock as unknown as typeof fetch).delete([])
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects when any key fails to delete', async () => {
        const fetchMock = vi.fn(async (url: string) => url.endsWith('/bad.txt')
            ? new Response('<Error><Code>AccessDenied</Code><Message>denied</Message></Error>', {status: 403})
            : new Response(null, {status: 204}))
        await expect(adapter(fetchMock as unknown as typeof fetch).delete(['ok.txt', 'bad.txt'])).rejects.toThrow()
    })
})

describe('R2RestAdapter.putStream', () => {
    it('sends the stream as the PUT body', async () => {
        const fetchMock = vi.fn(async () => new Response(null, {status: 200, headers: {etag: '"e1"'}}))
        const bytes = new TextEncoder().encode('glTF-model-bytes')
        await adapter(fetchMock as unknown as typeof fetch).putStream('assets/city_cd34.glb', new Blob([bytes]).stream(), bytes.byteLength)
        expect(fetchMock).toHaveBeenCalledOnce()
        const [url, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]
        expect(url).toBe('https://ACC.r2.cloudflarestorage.com/bkt/assets/city_cd34.glb')
        expect(init.method).toBe('PUT')
        expect(new TextDecoder().decode(await new Response(init.body).arrayBuffer())).toBe('glTF-model-bytes')
    })

    it('rejects a size that is not a non-negative integer', async () => {
        const fetchMock = vi.fn(async () => new Response(null, {status: 200}))
        await expect(adapter(fetchMock as unknown as typeof fetch).putStream('k', new Blob(['x']).stream(), -1)).rejects.toThrow(/invalid size/)
        expect(fetchMock).not.toHaveBeenCalled()
    })
})

// $Database.putFileObject only streams through putStream when the bucket has that method. A native
// binding must not, so self-hosted uploads keep passing the File straight to R2 without a copy.
describe('putFileObject with a native R2 binding', () => {
    it('a native R2Bucket has no putStream', () => {
        expect(typeof (env.PRIMARY_R2 as unknown as {putStream?: unknown}).putStream).toBe('undefined')
    })

    it('stores a File with its bytes and content type', async () => {
        const vars = new Map<string, unknown>()
        const c = {env: {}, req: {header: () => undefined}, set: (k: string, v: unknown) => vars.set(k, v), get: (k: string) => vars.get(k)} as never
        const db = new $Database(c, {appUrl: 'http://localhost', jwtSecret: 'x', tables: []} as never, undefined, env.PRIMARY_R2) as unknown as {
            putFileObject(key: string, value: unknown, options?: unknown): Promise<unknown>
        }
        const file = new File(['<h1>native</h1>'], 'index.html', {type: 'text/html'})
        await db.putFileObject('assets/index_n1.html', file, {httpMetadata: {contentType: 'text/html'}})
        const object = await env.PRIMARY_R2!.get('assets/index_n1.html')
        expect(await object!.text()).toBe('<h1>native</h1>')
        expect(object!.httpMetadata?.contentType).toBe('text/html')
    })
})
