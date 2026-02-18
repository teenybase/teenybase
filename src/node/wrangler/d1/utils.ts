import {UserError} from '../../workers-utils/errors'
// import {listDatabases} from "./list";
import type {Database} from "./types";

// todo keep updated with https://github.com/cloudflare/workers-sdk/blob/3b06b18670bd975a6ffc1678b9d9c787f3dcf10a/packages/wrangler/src/d1/utils.ts#L8

export function getDatabaseInfoFromConfig(
    config: any,
    // config: Config,
    name: string,
    options?: {
        /**
         * Local databases might not have a database id, so we don't require it for local-only operations
         * @default true
         */
        requireDatabaseId?: boolean;
    }
): Omit<Database, 'migrationsTableName'|'migrationsFolderPath'> | null {
    const requireDatabaseId = options?.requireDatabaseId ?? true;

    for (const d1Database of config.d1_databases) {
        if (name === d1Database.database_name || name === d1Database.binding) {
            if (requireDatabaseId && !d1Database.database_id) {
                throw new UserError(
                    `Found a database with name or binding ${name} but it is missing a database_id, which is needed for operations on remote resources. Please create the remote D1 database by deploying your project or running 'wrangler d1 create ${name}'.`
                );
            }
            // If requireDatabaseId is true (default), skip entries without database_id
            // This is needed for remote operations that require a real database UUID

            // For local operations, fall back to using the binding as the ID
            // This matches the behavior in wrangler dev (see d1DatabaseEntry in dev/miniflare/index.ts)
            const uuid = d1Database.database_id ?? d1Database.binding;

            return {
                uuid,
                previewDatabaseUuid: d1Database.preview_database_id,
                binding: d1Database.binding,
                name: d1Database.database_name,
                // migrationsTableName:
                //     d1Database.migrations_table || DEFAULT_MIGRATION_TABLE,
                // migrationsFolderPath:
                //     d1Database.migrations_dir || DEFAULT_MIGRATION_PATH,
                // internal_env: d1Database.database_internal_env,
            };
        }
    }
    return null;
}
