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

export default {
    fetch() {
        return new Response('rpc recorder')
    },
}
