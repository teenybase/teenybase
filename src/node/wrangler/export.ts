import fs from "node:fs/promises";
import path from "node:path";
import {Miniflare} from "miniflare";
import {UserError} from './parse'
import {Logger} from '../logger'
import {readableRelative} from '../utils'

export function getDatabaseInfoFromConfig(
    config: any, // wrangler config
    name: string
) {
    for (const d1Database of config.d1_databases) {
        if (
            d1Database.database_id &&
            (name === d1Database.database_name || name === d1Database.binding)
        ) {
            return {
                uuid: d1Database.database_id,
                previewDatabaseUuid: d1Database.preview_database_id,
                binding: d1Database.binding,
                name: d1Database.database_name,
                // migrationsTableName:
                //     d1Database.migrations_table,
                // migrationsFolderPath:
                //     d1Database.migrations_dir,
                // internal_env: d1Database.database_internal_env,
            };
        }
    }
    return null;
}

// todo keep updated with https://github.com/cloudflare/workers-sdk/blob/5462ead9207459e7547ba571157159c8618d3583/packages/wrangler/src/d1/export.ts#L101

export async function exportLocal(
    config: any, // wrangler config
    name: string,
    output: string,
    tables: string[],
    noSchema: boolean,
    noData: boolean,
    persistencePath: string,
    logger: Logger,
) {
    const localDB = getDatabaseInfoFromConfig(config, name);
    if (!localDB) {
        throw new UserError(
            `Couldn't find a D1 DB with the name or binding '${name}' in wrangler.toml.`
        );
    }

    const id = localDB.previewDatabaseUuid ?? localDB.uuid;

    const d1Persist = path.join(persistencePath, "v3", "d1");

    logger.info(
        `🌀 Exporting local database ${name} (${id}) from ${readableRelative(
            d1Persist
        )}:`
    );

    const mf = new Miniflare({
        modules: true,
        script: "export default {}",
        d1Persist,
        d1Databases: { DATABASE: id },
    });
    const db = await mf.getD1Database("DATABASE");
    logger.info(`🌀 Exporting SQL to ${output}...`);

    try {
        // Special local-only export pragma. Query must be exactly this string to work.
        const dump = await db
            .prepare(`PRAGMA miniflare_d1_export(?,?,?);`)
            .bind(noSchema, noData, ...tables)
            .raw();
        await fs.writeFile(output, dump[0].join("\n"));
    } catch (e) {
        throw new UserError((e as Error).message);
    } finally {
        await mf.dispose();
    }

    logger.info(`Done!`);
}
