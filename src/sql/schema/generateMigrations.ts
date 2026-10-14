import {DatabaseSettings} from "../../types/config";
import {TableData} from "../../types/table";
import {dropTable} from "./dropTable";
import {alterTable} from "./alterTable";
import {createTable} from "./createTable";
import { validateSettingsChange } from '../../types/config/validateSettingsChange';
import {z} from 'zod'
import {formatZodError} from '../../utils/zod'

// User migrations start at 10000. The 0–9999 band is reserved for infra migrations recorded
// by $Database.setup (kv=00000, identities=00001, extension-owned=0000x). Sorting _db_migrations
// by name therefore always puts infra before user migrations on replay.
export const USER_MIGRATION_START = 10000

// Compute the next user-band prefix from an existing migrations list. Assumes `migrations`
// is in id-order (as returned by MigrationHelperRaw.list) so the last matching row is the
// highest-numbered one. Rows outside the user band (infra, or non-NNNNN_ names) are ignored.
export function nextUserIndex(migrations: { name: string }[]): number {
    const userRows = migrations.filter(m => {
        const n = parseInt(String(m.name).split('_')[0], 10)
        return Number.isFinite(n) && n >= USER_MIGRATION_START
    })
    if (!userRows.length) return USER_MIGRATION_START
    return parseInt(String(userRows[userRows.length - 1].name).split('_')[0], 10) + 1
}

export function generateMigrations(nextConfig: DatabaseSettings, lastConfig: Partial<DatabaseSettings> | undefined, index = USER_MIGRATION_START) {
    let res

    try {
        res = validateSettingsChange(nextConfig, lastConfig)
    }catch (e) {
        if(e instanceof z.ZodError) {
            throw new Error(formatZodError(e, 'Error validating database settings change:'))
        }
        throw e
    }

    const {config, changes} = res
    if (!changes) return {migrations: [], config: config, changes: null}
    const name = (op: string, table: TableData) => `${String(index++).padStart(5, '0')}_${op}_table_${table.name}.sql`
    const others = (table: TableData) => config.tables.filter((t) => t.name !== table.name)
    const migrations = [
        ...changes.create.map(item => ({
            name: name('create', item),
            ...createTable(item, others(item))
        })),
        ...changes.drop.map(item => ({
            name: name('drop', item),
            ...dropTable(item, others(item))
        })),
        ...changes.alter.map(item => ({
            name: name('alter', item[0]),
            ...alterTable(item, others(item[0]))
        }))
    ].filter(m => m.sql.trim().length)

    const extraLogs = [] as string[]

    // remove lastName from tables and fields. this is required so that it doesn't interfere from next time.
    for (const table of config.tables) {
        if(table.lastName !== undefined) {
            extraLogs.push(`⚠ You need to Remove ${table.name}.lastName from config file for next migration`)
            delete table.lastName
        }
        for (const field of table.fields) {
            if(field.lastName !== undefined) {
                extraLogs.push(`⚠ You need to Remove ${table.name}.fields.${field.name}.lastName field config file for next migration`)
                delete field.lastName
            }
        }
    }

    return {migrations, config, extraLogs, changes}
}
