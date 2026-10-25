import {createExecutionContext, env, ProvidedEnv, waitOnExecutionContext} from 'cloudflare:test'
import {beforeAll, describe, expect, it} from 'vitest'
import {$Database, $Env, D1Adapter, teenyHono} from '../../src/worker'
import {DatabaseSettings} from '../../src'
import {setup} from '../data/drive2/setup'

// Regression suite for file fields when the bucket sits behind a Workers RPC boundary.
//
// A `$Database` bucket can be an RPC stub (for example to `R2RestRPC` in another worker) instead
// of a native R2 binding. Through such a stub:
//
// - a multipart upload hands `putFileObject` a `File`, and workerd's RPC serializer refuses File
//   and Blob (`Could not serialize object of type "File"`) and caps other values at 32 MiB, so
//   uploads now go through `putStream(key, file.stream(), file.size)`;
// - the cleanup delete after a failed insert/update used to replace the original error with
//   "Failed to delete files";
// - an object's `writeHttpMetadata(headers)` is an RPC stub that fills a serialized copy of the
//   headers, so `/api/v1/files/...` responses went out without their content-type.
//
// `env.RECORDING_R2` is a service binding to `RecordingR2Rpc` in rpcRecorderWorker.js, a small
// in-memory bucket, so every call here really crosses the RPC serializer. The native R2 binding
// used by the other suites accepts File in-process and can't catch any of this.

const ADMIN = 'test_admin_service_token'

type Recorded = {method: string, key?: string, size?: number, received?: number, head?: string, kind?: string, keys?: string | string[], isArray?: boolean}
type RecorderControls = {
    _calls(key: string): Promise<Recorded[]>
    _setDeleteFailures(on: boolean): Promise<void>
    _has(key: string): Promise<boolean>
}

const bucket = () => env.RECORDING_R2 as unknown as R2Bucket
const controls = () => env.RECORDING_R2 as unknown as RecorderControls

/** A $Database with just enough context to reach putFileObject. */
function dbWith(b: R2Bucket) {
    const vars = new Map<string, unknown>()
    const c = {env: {}, req: {header: () => undefined}, set: (k: string, v: unknown) => vars.set(k, v), get: (k: string) => vars.get(k)} as never
    const db = new $Database(c, {appUrl: 'http://localhost', jwtSecret: 'x', tables: []} as never, undefined, b)
    return db as unknown as {
        putFileObject(key: string, value: unknown, options?: unknown): Promise<R2Object>
    }
}

describe('putFileObject over a Workers RPC boundary', () => {
    it('streams a File across the stub with its size and bytes', async () => {
        const file = new File(['body{color:red}'], 'style.css', {type: 'text/css'})

        // Before the fix this rejected with `Could not serialize object of type "File"`.
        const res = await dbWith(bucket()).putFileObject('rpc-a/style_ab12.css', file, {httpMetadata: {contentType: 'text/css'}})

        expect(res.key).toBe('rpc-a/style_ab12.css')
        expect(res.httpMetadata).toEqual({contentType: 'text/css'})
        expect(await controls()._calls('rpc-a/style_ab12.css')).toEqual([
            {method: 'putStream', key: 'rpc-a/style_ab12.css', size: 15, received: 15, head: 'body{color:red}'},
        ])
    })

    it('streams a file larger than the 32 MiB RPC serialization limit', async () => {
        const size = 33 * 1024 * 1024
        const bytes = new Uint8Array(size)
        bytes.set(new TextEncoder().encode('glTF'), 0)
        const file = new File([bytes], 'city.glb', {type: 'model/gltf-binary'})

        await dbWith(bucket()).putFileObject('rpc-b/city_cd34.glb', file)

        const [call] = await controls()._calls('rpc-b/city_cd34.glb')
        expect(call.method).toBe('putStream')
        expect(call.size).toBe(size)
        expect(call.received).toBe(size)
        expect(call.head?.startsWith('glTF')).toBe(true)
    })

    it('streams a plain Blob too', async () => {
        await dbWith(bucket()).putFileObject('rpc-c/b.bin', new Blob(['blob-bytes']))

        expect(await controls()._calls('rpc-c/b.bin')).toEqual([
            {method: 'putStream', key: 'rpc-c/b.bin', size: 10, received: 10, head: 'blob-bytes'},
        ])
    })

    it('still sends a string body through put', async () => {
        await dbWith(bucket()).putFileObject('rpc-d/a.txt', 'hello')

        expect(await controls()._calls('rpc-d/a.txt')).toEqual([{method: 'put', key: 'rpc-d/a.txt', kind: 'string'}])
    })

    it('a raw File or Blob is what the RPC boundary rejects', async () => {
        // Characterises the platform constraint putStream exists for, so the reason stays on record
        // if a future workerd starts serializing them.
        const stub = bucket() as unknown as {put(key: string, body: unknown): Promise<unknown>}

        await expect(stub.put('rpc-e/k', new File(['x'], 'x.txt'))).rejects.toThrow(/Could not serialize object of type "File"/)
        await expect(stub.put('rpc-e/k', new Blob(['x']))).rejects.toThrow(/Could not serialize object of type "Blob"/)
    })
})

// The full HTTP path: multipart insert, download, and the cleanup after a failed insert, with
// the `files` table of the drive2 fixture (r2Base `files`, file fields `file` and `thumb`).
type Env = $Env & {Bindings: ProvidedEnv}
const app = teenyHono<Env>(async (c) => new $Database(c, undefined, new D1Adapter(c.env.PRIMARY_DB), c.env.RECORDING_R2 as unknown as R2Bucket),
    undefined, {logger: false, cors: false})

let settings: DatabaseSettings
beforeAll(async () => { settings = await setup() as unknown as DatabaseSettings })

async function call(path: string, init: RequestInit = {}) {
    const ctx = createExecutionContext()
    const headers = new Headers(init.headers)
    headers.set('$DB_TEST_DATABASE_SETTINGS', JSON.stringify(settings))
    headers.set('Authorization', 'Bearer ' + ADMIN)
    const res = await app.fetch(new Request('https://example.com/api/v1/' + path, {...init, headers}), env, ctx)
    await waitOnExecutionContext(ctx)
    return res
}

function insertForm(values: Record<string, unknown>, file: File) {
    const data = new FormData()
    data.append('@filePayload', file)
    data.append('returning', 'id,file')
    data.append('@jsonPayload', JSON.stringify({values: {...values, file: '@filePayload.0'}}))
    return data
}

describe('file fields through an RPC bucket', () => {
    it('uploads a file on insert and serves it with its content type', async () => {
        const file = new File(['hello over rpc'], 'note.txt', {type: 'text/plain; charset=utf-8'})

        const res = await call('table/files/insert', {method: 'POST', body: insertForm({path: '/rpc/', name: 'RPC file'}, file)})
        expect(res.status).toBe(200)
        const [row] = await res.json() as {id: string, file: string}[]
        expect(row.file).toMatch(/^note_[a-z0-9]{10}\.txt$/)

        const key = 'files/' + row.file
        const [put] = await controls()._calls(key)
        expect(put).toMatchObject({method: 'putStream', size: 14, received: 14})

        const download = await call(`files/files/${row.id}/${row.file}`)
        expect(download.status).toBe(200)
        expect(await download.text()).toBe('hello over rpc')
        // writeHttpMetadata() over RPC fills a copy; these come from httpMetadata instead.
        expect(download.headers.get('content-type')).toBe('text/plain; charset=utf-8')
        expect(download.headers.get('cache-control')).toBe('public, max-age=31536000')
    })

    it('a failed cleanup does not replace the error that caused it', async () => {
        await controls()._setDeleteFailures(true)
        try {
            const file = new File(['orphan'], 'orphan.txt', {type: 'text/plain'})
            // `created_by` references users(id); no such user, so the INSERT fails after the upload.
            const res = await call('table/files/insert', {
                method: 'POST',
                body: insertForm({path: '/rpc/', name: 'Bad ref', created_by: 'no-such-user'}, file),
            })
            const body = await res.json() as {message?: string}

            expect(body.message ?? '').not.toMatch(/Failed to delete files/)
            expect(res.status).toBe(400)
            expect(JSON.stringify(body)).toMatch(/FOREIGN KEY/i)
        } finally {
            await controls()._setDeleteFailures(false)
        }
    })
})
