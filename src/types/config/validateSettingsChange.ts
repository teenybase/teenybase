import {z} from 'zod'
import {databaseSettingsSchema} from '../zod/databaseSettingsSchema';
import {jsonStringify} from '../../utils/string';
import {AlterSettings, DatabaseSettings} from '../config';
import {validateTableChange} from './validateTableChange'
import {zParseWithPath, zCustomError} from '../../utils/zod'

export function validateSettingsChange(nextConfig: DatabaseSettings, lastConfig: Partial<DatabaseSettings> | undefined) {
    nextConfig = zParseWithPath(databaseSettingsSchema, nextConfig, ['settings'])

    {
        // Strip `version` before equality — CLI stamps it on every deploy so it changes
        // even when no real settings changed. Authoritative counter is `$settings_version`
        // KV row; `settings.version` is just the deploy-time mirror.
        const n = {...nextConfig}
        delete n.version
        delete n['//']
        const l = {...lastConfig}
        delete l.version
        delete l['//']
        if (jsonStringify(n) === jsonStringify(l)) return {config: null, changes: null}
    }

    // todo make sure table name fields like _kvTableName(used in cli-utils) etc cannot be changed.

    const issues: z.core.$ZodIssue[] = []
    const res: AlterSettings = {create: [], drop: [], alter: []}
    for (const table of nextConfig.tables) {
        if (nextConfig.tables.find(t => t.name === table.name) !== table) throw zCustomError(`Duplicate table name found in nextConfig`, 'settings', 'tables', table.name)

        const lastTable = lastConfig?.tables?.filter(t => t.name === table.name || t.name === table.lastName) ?? []
        if (lastTable.length > 1) issues.push({code: "custom", message: `Duplicate table name found in lastConfig`, path: ['settings', 'tables', table.name]})
        try {
            const res1 = validateTableChange(table, lastTable[0], nextConfig, ['settings', 'tables'])
            if (res1.create) res.create.push(res1.create)
            if (res1.drop) res.drop.push(res1.drop)
            if (res1.alter) res.alter.push(res1.alter)
        } catch (e) {
            if (e instanceof z.ZodError) issues.push(...e.issues)
            else throw e
        }
    }
    for (const table of lastConfig?.tables || []) {
        const nextTable = nextConfig.tables.filter(t => t.name === table.name || t.lastName === table.name) ?? []
        if (nextTable.length > 1) issues.push({code: "custom", message: `Duplicate table name found in nextConfig`, path: ['settings', 'tables', table.name]})
        if (!nextTable.length) { // deleted field
            try {
                const res1 = validateTableChange(undefined, table, nextConfig, ['settings', 'tables'])
                if (res1.create) res.create.push(res1.create)
                if (res1.drop) res.drop.push(res1.drop)
                if (res1.alter) res.alter.push(res1.alter)
            } catch (e) {
                if (e instanceof z.ZodError) issues.push(...e.issues)
                else throw e
            }
        }
    }
    if (issues.length) throw new z.ZodError(issues)
    return {config: nextConfig, changes: res}
}
