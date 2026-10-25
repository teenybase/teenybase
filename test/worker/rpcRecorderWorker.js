// Auxiliary worker for test/worker (see vitest.config.ts). It is plain JS because the
// workers pool loads auxiliary workers as-is, without Vite.
//
// Its entrypoints are bound into the test worker as service bindings, so every call to
// them crosses workerd's RPC serializer exactly as a storage adapter in another worker
// would. They record what actually arrived so tests can assert the wire shape.
import {WorkerEntrypoint} from 'cloudflare:workers'

/** Stand-in for an RPC storage adapter (`StorageAdapter` over a service binding). */
export class RecordingDbRpc extends WorkerEntrypoint {
    async run(q, v) {
        return {success: true, results: [{q, v: Array.from(v)}], meta: {}}
    }

    async runBatch(queries) {
        return queries.map((query) => ({
            success: true,
            results: [{q: query.q, v: Array.from(query.v), plainArray: Array.isArray(query.v)}],
            meta: {},
        }))
    }
}

// In-memory object store behind RecordingR2Rpc. Module state lives as long as this worker's
// isolate, so tests use unique keys. `deleteFailures` makes every delete() reject (to test that
// a failed cleanup does not replace the error that triggered it).
const objects = new Map()
const calls = []
let deleteFailures = false

function objectFor(key, entry) {
    return {
        key,
        size: entry.bytes.byteLength,
        etag: entry.etag,
        httpEtag: `"${entry.etag}"`,
        uploaded: entry.uploaded,
        httpMetadata: entry.httpMetadata,
        customMetadata: entry.customMetadata,
    }
}

function store(key, bytes, options) {
    const entry = {
        bytes,
        etag: 'etag' + objects.size,
        uploaded: new Date(),
        httpMetadata: options?.httpMetadata ?? {},
        customMetadata: options?.customMetadata ?? {},
    }
    objects.set(key, entry)
    return objectFor(key, entry)
}

/**
 * Stand-in for an R2 bucket exposed over RPC (the shape of R2RestRPC in src/worker/storage):
 * the R2Bucket methods plus `putStream`. Objects it returns are plain data plus functions, as
 * R2RestAdapter's are, so across RPC their methods become stubs: `writeHttpMetadata(headers)`
 * then fills a serialized copy of `headers`, never the caller's object.
 */
export class RecordingR2Rpc extends WorkerEntrypoint {
    async put(key, body, options) {
        calls.push({method: 'put', key, kind: typeof body})
        const bytes = typeof body === 'string' ? new TextEncoder().encode(body)
            : body instanceof ArrayBuffer ? new Uint8Array(body)
            : ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
            : new Uint8Array(await new Response(body).arrayBuffer())
        return store(key, bytes, options)
    }

    async putStream(key, stream, size, options) {
        // Read it all so tests see the bytes that actually arrived, not just the declared size.
        const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
        calls.push({method: 'putStream', key, size, received: bytes.byteLength, head: new TextDecoder().decode(bytes.subarray(0, 64))})
        return store(key, bytes, options)
    }

    async head(key) {
        const entry = objects.get(key)
        return entry ? objectFor(key, entry) : null
    }

    async get(key) {
        const entry = objects.get(key)
        if (!entry) return null
        const httpMetadata = entry.httpMetadata
        return {
            ...objectFor(key, entry),
            body: new Blob([entry.bytes]).stream(),
            writeHttpMetadata(headers) {
                if (httpMetadata.contentType) headers.set('content-type', httpMetadata.contentType)
                if (httpMetadata.cacheControl) headers.set('cache-control', httpMetadata.cacheControl)
            },
        }
    }

    async delete(keys) {
        calls.push({method: 'delete', keys, isArray: Array.isArray(keys)})
        if (deleteFailures) throw new Error('simulated delete failure')
        for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key)
    }

    // Test controls, not part of the bucket surface.
    async _calls(key) {
        return calls.filter(c => c.key === key || (Array.isArray(c.keys) && c.keys.includes(key)) || c.keys === key)
    }

    async _setDeleteFailures(on) {
        deleteFailures = on
    }

    async _has(key) {
        return objects.has(key)
    }
}

export default {
    fetch() {
        return new Response('rpc recorder')
    },
}
