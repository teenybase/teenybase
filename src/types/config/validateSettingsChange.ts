import {databaseSettingsSchema} from '../zod/databaseSettingsSchema';
import {jsonStringify} from '../../utils/string';
import {AlterSettings, DatabaseSettings} from '../config';
import {validateTableChange} from './validateTableChange'
import {zParseWithPath, zCustomError} from '../../utils/zod'

export function validateSettingsChange(nextConfig: DatabaseSettings, lastConfig: Partial<DatabaseSettings> | undefined) {
    // validations
    nextConfig = zParseWithPath(databaseSettingsSchema, nextConfig, ['settings'])
    if (nextConfig.version !== undefined) throw zCustomError(`Database settings version should not be set manually`, 'settings', 'version')
    // if(nextConfig.version !== undefined && nextConfig.version !== lastConfig?.version) throw createValidationError(`Database version mismatch - ${nextConfig.version} !== ${lastConfig?.version}`, 'settings', 'version')

    {
        // not using destructuring to override properties as its not changing the order in nodejs
        const n = {...nextConfig}
        delete n.version
        delete n['//']
        const l = {...lastConfig}
        delete l.version
        delete l['//']
        if (jsonStringify(n) === jsonStringify(l)) return {config: null, changes: null}
    }

    // diff
    nextConfig.version = (nextConfig?.version ?? -1) + 1

    const res: AlterSettings = {create: [], drop: [], alter: []}
    for (const table of nextConfig.tables) {
        if (nextConfig.tables.find(t => t.name === table.name) !== table) throw zCustomError(`Duplicate table name found in nextConfig`, 'settings', 'tables', table.name)
        const lastTable = lastConfig?.tables?.filter(t => t.name === table.name || t.name === table.lastName) ?? []
        if (lastTable.length > 1) throw zCustomError(`Duplicate table name found in lastConfig`, 'settings', 'tables', table.name)
        const res1 = validateTableChange(table, lastTable[0], nextConfig, ['settings', 'tables'])
        if (res1.create) res.create.push(res1.create)
        if (res1.drop) res.drop.push(res1.drop)
        if (res1.alter) res.alter.push(res1.alter)
    }
    for (const table of lastConfig?.tables || []) {
        const nextTable = nextConfig.tables.filter(t => t.name === table.name || t.lastName === table.name) ?? []
        if (nextTable.length > 1) throw zCustomError(`Duplicate table name found in nextConfig`, 'settings', 'tables', table.name)
        if (!nextTable.length) { // deleted field
            const res1 = validateTableChange(undefined, table, nextConfig, ['settings', 'tables'])
            if (res1.create) res.create.push(res1.create)
            if (res1.drop) res.drop.push(res1.drop)
            if (res1.alter) res.alter.push(res1.alter)
        }
    }
    return {config: nextConfig, changes: res}
}
