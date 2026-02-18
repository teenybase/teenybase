import fs from "node:fs/promises";
import path from "node:path";
import {Miniflare} from "miniflare";
import {Logger} from '../../logger'
import {readableRelative} from '../../utils'
import {getDatabaseInfoFromConfig} from './utils'
import {UserError} from '../../workers-utils/errors'

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
            `Couldn't find a D1 DB with the name or binding '${name}' in wrangler config.`
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
