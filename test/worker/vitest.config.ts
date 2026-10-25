import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Auxiliary worker whose entrypoints are bound below, so tests can call a storage adapter or
// bucket that sits behind a real Workers RPC boundary (see rpcRecorderWorker.js).
const rpcRecorderWorker = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "rpcRecorderWorker.js");

export default defineWorkersConfig({
    test: {
        poolOptions: {
            workers: {
                main: "./sampleHonoApp.ts",
                // wrangler: { configPath: "./wrangler.toml" },
                singleWorker: true,
                isolatedStorage: true,
                miniflare: {
                    compatibilityDate: "2024-08-06",
                    compatibilityFlags: ["nodejs_compat"],
                    bindings: {
                        IS_VITEST: true,
                        RESPOND_WITH_QUERY_LOG: true,
                        RESPOND_WITH_ERRORS: true,
                        ADMIN_SERVICE_TOKEN: "test_admin_service_token",
                        ADMIN_JWT_SECRET: "test_admin_jwt_secret",
                    },
                    d1Databases: ["PRIMARY_DB"],
                    r2Buckets: ["PRIMARY_R2"],
                    serviceBindings: {
                        RECORDING_DB: { name: "rpc-recorder", entrypoint: "RecordingDbRpc" },
                        RECORDING_R2: { name: "rpc-recorder", entrypoint: "RecordingR2Rpc" },
                    },
                    workers: [{
                        name: "rpc-recorder",
                        modules: true,
                        scriptPath: rpcRecorderWorker,
                        compatibilityDate: "2024-08-06",
                        compatibilityFlags: ["nodejs_compat"],
                    }],
                },
            },
        },
    },
});
