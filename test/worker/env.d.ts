declare module "cloudflare:test" {
    // import {D1Migration } from '@cloudflare/vitest-pool-workers/dist/shared/d1'

    import {$CloudflareBindings} from '../../src/worker'

    interface ProvidedEnv extends $CloudflareBindings {
        // TEST_MIGRATIONS: D1Migration[]; // Defined in `vitest.config.mts`
        PRIMARY_DB: D1Database; // Defined in `vitest.config.mts`
        PRIMARY_R2?: R2Bucket; // Defined in `vitest.config.mts`
    }
}
