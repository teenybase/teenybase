import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

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
                    },
                    d1Databases: ["PRIMARY_DB"],
                    r2Buckets: ["PRIMARY_R2"],
                },
            },
        },
    },
});
