import {AlterTable, TableData, tableDataSchema, validateTableChange} from "./table";
import {BaseTemplateProps, baseTemplatePropsSchema} from "./email";
import {MailgunBindings, mailgunBindingsSchema} from "./mailgun";
import {z} from 'zod'
import {QueryTypes} from '../sql/build/query'
import {SQLProcedure, zSQLProcedure} from './sql'
import {jsonStringify} from '../utils/string'

export interface DatabaseSettings {
    tables: TableData[]
    jwtSecret: string
    jwtIssuer?: string
    jwtAlgorithm?: string

    appName?: string
    appUrl: string

    procedures?: SQLProcedure[]

    email?: {
        from: string // default, in-case not provided in sendEmail
        variables: BaseTemplateProps

        tags?: string[] // used only in case of mailgun
        mailgun?: MailgunBindings
    }

    // this should not be changed manually
    version?: number // todo rename to _version

    _kvTableName?: string

    // todo implement below in backend
    disableTablesEdit?: boolean // disable/throw error creating and editing tables

    // for comments and notes
    ['//']?: string
}

export const databaseSettingsSchema = z.object({
    tables: z.array(tableDataSchema),
    jwtSecret: z.string(),
    jwtIssuer: z.string().optional(),
    jwtAlgorithm: z.string().optional(),
    version: z.number().optional(),
    appName: z.string().optional(),
    appUrl: z.string(),
    procedures: z.array(zSQLProcedure).optional(),
    email: z.object({
        from: z.string(),
        variables: baseTemplatePropsSchema,
        tags: z.array(z.string()).optional(),
        mailgun: mailgunBindingsSchema,
    }).optional(),
    _kvTableName: z.string().startsWith('_', {message: 'Internal table name must start with _ (underscore)'}).optional(),
    disableTablesEdit: z.coerce.boolean().optional(),
})

export type AlterSettings = {create: TableData[], drop: TableData[], alter: AlterTable[]}
export function validateSettingsChange(nextConfig: DatabaseSettings, lastConfig: Partial<DatabaseSettings>|undefined) {
    // validations
    nextConfig = databaseSettingsSchema.parse(nextConfig)
    if(nextConfig.version !== undefined) throw new Error(`Database settings version should not be set manually`)
    // if(nextConfig.version !== undefined && nextConfig.version !== lastConfig?.version) throw new Error(`Database version mismatch - ${nextConfig.version} !== ${lastConfig?.version}`)

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
    for(const table of nextConfig.tables){
        if(nextConfig.tables.find(t=>t.name === table.name) !== table) throw new Error(`Table ${table.name} - Duplicate table name found in nextConfig`)
        const lastTable = lastConfig?.tables?.filter(t=>t.name === table.name || t.name === table.lastName) ?? []
        if(lastTable.length > 1) throw new Error(`Table ${table.name} - Duplicate table name found in lastConfig`)
        const res1 = validateTableChange(table, lastTable[0], nextConfig)
        if(res1.create) res.create.push(res1.create)
        if(res1.drop) res.drop.push(res1.drop)
        if(res1.alter) res.alter.push(res1.alter)
    }
    for(const table of lastConfig?.tables||[]){
        const nextTable = nextConfig.tables.filter(t=>t.name === table.name || t.lastName === table.name) ?? []
        if(nextTable.length > 1) throw new Error(`Table ${table.name} - Duplicate table name found in nextConfig`)
        if(!nextTable.length){ // deleted field
            const res1 = validateTableChange(undefined, table, nextConfig)
            if(res1.create) res.create.push(res1.create)
            if(res1.drop) res.drop.push(res1.drop)
            if(res1.alter) res.alter.push(res1.alter)
        }
    }
    return {config: nextConfig, changes: res}
}

