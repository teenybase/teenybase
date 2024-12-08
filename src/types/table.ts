import {AlterField, TableFieldData, tableFieldDataSchema, validateFieldChange} from "./field";
import {z} from 'zod'
import {SQLIndex, SQLTrigger, tableColumnNameSchema, zSQLIndex, zSQLTrigger} from './sql'
import {DatabaseSettings} from './config'
import {TableFieldUsageRecord} from '../worker/usages'
import {tableExtensionSchemas} from './tableExtensions'
import {indexName} from '../sql/schema/tableQueries'

export interface TableData<TF extends TableFieldData=TableFieldData, TE extends TableExtensionData=TableExtensionData>{
    // id: string
    name: string
    /**
     * Base path to save the files in r2.
     * By default, the table id/name is used
     */
    r2Base?: string
    /**
     * Use record uid in r2 path key.
     * Can be used for direct access control but requires noUpdate to be set on id field and allowMultipleFileRef to be false.
     * Default is false.
     */
    idInR2?: boolean
    /**
     * Automatically delete files in r2 when reference is removed.
     * Disable this to keep the files and allow re-referencing files across rows(allowMultipleFileRef).
     * default is true
     */
    autoDeleteR2Files?: boolean // default is true
    /**
     * allow referencing files in a table by path across rows, default is false.
     * if this is true, then idInR2 must not be true and autoDeleteR2Files must be false.
     */
    allowMultipleFileRef?: boolean

    allowWildcard?: boolean // like `select *`

    /**
     * Columns in the table, see {@link TableFieldData}
     */
    fields: TF[]

    /**
     * Indexes
     */
    indexes?: SQLIndex[]

    /**
     * Triggers
     */
    triggers?: SQLTrigger[]

    /**
     * Foreign keys. Other than foreign keys specified in fields.
     */
    // foreignKeys?: todo

    /**
     * if true, record_uid will be set automatically to uuidv4(when using insert route). type must be text
     *
     * default - false
     */
    autoSetUid?: boolean

    extensions: TE[]

    fullTextSearch?: {
        enabled?: boolean // default true
        fields: string[]
        // https://sqlite.org/fts5.html#fts5_table_creation_and_initialization
        tokenize?: string // tokenizer
        prefix?: string

        /**
         * set content=table_name
         * default = true
         */
        contentless?: boolean
        // content?: string
        content_rowid?: string
        // contentless_delete?: string
        columnsize?: 0|1
        detail?: "full"|"column"|"none"
    }

    lastName?: string
}

// export interface TableExtensionData<T=ExtensionsKeys> {
export interface TableExtensionData<T=string> {
    name: T
    // [key: string]: any
}

export const tableDataSchema = z.object({
    // id: z.string(),
    name: tableColumnNameSchema,
    r2Base: z.string().optional(),
    idInR2: z.coerce.boolean().optional(),
    autoDeleteR2Files: z.coerce.boolean().optional(),
    allowMultipleFileRef: z.coerce.boolean().optional(),
    allowWildcard: z.coerce.boolean().optional(),
    fields: z.array(tableFieldDataSchema),
    indexes: z.array(zSQLIndex).optional(),
    triggers: z.array(zSQLTrigger).optional(),
    autoSetUid: z.coerce.boolean().optional(),
    extensions: z.array(z.record(z.any()).and(z.object({name: z.string()}))),
    lastName: tableColumnNameSchema.optional(),
    fullTextSearch: z.object({
        enabled: z.coerce.boolean().optional(),
        fields: z.array(tableColumnNameSchema),
        tokenize: z.string().optional(),
        prefix: z.string().optional(),
        // content: z.string().optional(),
        migrateTableQuery: z.coerce.boolean().default(true),
        content_rowid: z.string().optional(),
        columnsize: z.literal(0).or(z.literal(1)).optional(),
        detail: z.enum(["full", "column", "none"]).optional(),
    }).optional(),
})

// [nextTable, lastTable, fieldChanges]
export type AlterTable = [TableData, TableData, {create: TableFieldData[], drop: TableFieldData[], alter: AlterField[], indexes: {create: SQLIndex[], drop: SQLIndex[]}, triggers: {create: SQLTrigger[], drop: SQLTrigger[]}, fts: boolean}]
export function validateTableChange(nextTable: TableData|undefined, lastTable: TableData|undefined, nextSettings?: DatabaseSettings) {
    if(!nextTable){
        if(!lastTable) return {}
        // todo handle dropped table like deleting files from r2, taking backup etc
        // throw new Error('not implemented')
        return {drop: lastTable}
    }
    if(lastTable && JSON.stringify(nextTable) === JSON.stringify(lastTable)) return {}

    const prefix = `Table ${nextTable.name} - `

    // validations
    if(lastTable && nextTable.name !== lastTable?.name) {
        if(nextTable.lastName !== lastTable?.name) throw new Error(prefix + `Last table name must be set to ${lastTable.name} when changing table name`)

        if(lastTable.r2Base && nextTable.r2Base !== lastTable.r2Base){
            // todo check if there are files in the bucket under base, and throw error only then
            throw new Error(prefix + `r2Base cannot be changed - ${nextTable.r2Base} !== ${lastTable.r2Base}`)
        }
        if(!lastTable.r2Base && nextTable.r2Base !== lastTable.name) {
            // todo check if there are files in the bucket under base, and throw error only then
            throw new Error(prefix + `r2Base must be set to "${lastTable.name}" because changing table name`)
        }

    }
    if(lastTable && nextTable.r2Base !== lastTable.r2Base && nextTable.name !== lastTable.r2Base && nextTable.r2Base !== lastTable.name){
        // todo check if there are files in the bucket under that base, and throw error only then
        throw new Error(prefix + `r2Base cannot be changed - ${nextTable.r2Base??nextTable.name} !== ${lastTable.r2Base}`)
    }
    if(lastTable && nextTable.idInR2 !== lastTable.idInR2){
        // todo check if there are files in the bucket under that base, and throw error only then
        throw new Error(prefix + `idInR2 cannot be changed - ${nextTable.r2Base} !== ${lastTable.r2Base}`)
    }
    if(lastTable && nextTable.allowMultipleFileRef !== lastTable.allowMultipleFileRef){
        // this is fine
    }
    if(lastTable && nextTable.autoDeleteR2Files !== lastTable.autoDeleteR2Files){
        // this is fine
    }

    if(nextTable.idInR2){
        // check if noUpdate field is set on id field
        const idField = nextTable.fields.find(f=>f.usage===TableFieldUsageRecord.record_uid)
        if(!idField || !idField.noUpdate) throw new Error(prefix + `idInR2 requires an id field with 'usage' = 'record_uid' and 'noUpdate' = 'true'.`)

        if(nextTable.allowMultipleFileRef){
            throw new Error(prefix + `allowMultipleFileRef cannot be true when idInR2 is true`)
        }
    }
    const autoDeleteR2Files = nextTable.autoDeleteR2Files ?? true // default is true

    if(nextTable.allowMultipleFileRef){
        if(nextTable.idInR2){
            throw new Error(prefix + `idInR2 cannot be true when allowMultipleFileRef is true`)
        }
        if(autoDeleteR2Files){
            throw new Error(prefix + `autoDeleteR2Files must be false when allowMultipleFileRef is true`)
        }
    }

    if(nextTable.allowWildcard){
        throw new Error(prefix + `allowWildcard is not supported yet`)
    }

    if(nextTable.autoSetUid){
        const idField = nextTable.fields.find(f=>f.usage===TableFieldUsageRecord.record_uid)
        if(!idField || idField.type !== 'text') throw new Error(prefix + `autoSetUid requires an id field with 'usage' = 'record_uid' and 'type' = 'text'.`)
    }

    const res: AlterTable[2] = {create: [], drop: [], alter: [], indexes: {create: [], drop: []}, triggers: {create: [], drop: []}, fts: false}

    // todo improve lastName logic using multiple passes?
    for (const field of nextTable.fields) {
        if(nextTable.fields.find(f=>f.name === field.name)!==field) throw new Error(`Field ${nextTable.name}:${field.name} - Duplicate field name`)
        let lastField = lastTable?.fields?.filter((f) => f.name === field.name || f.name === field.lastName) ?? []
        // remove the last fields that are renamed now.
        lastField = lastField.filter(lf=>{
            // find field in nextTable where lastName = lf.name
            const nextField = nextTable.fields.filter(f=>f.lastName === lf.name && f !== field)
            if(nextField.length > 1) throw new Error(`Field ${nextTable.name}:${lf.name} - Duplicate field name`)
            if(!nextField.length) return true
            // check if nextField[0] is renamed to lf
            // for that check if nextField is not in last table with same name and lastName
            const lastField2 = lastTable?.fields?.filter((f) => f.name === nextField[0].name && f.name === nextField[0].lastName) ?? []
            const renamed = !lastField2.length
            return !renamed
        })
        if(lastField.length > 1) {
            let cont = false
            // case. find exact match name and lastName both same
            const exact = lastField.find(f=>f.name === field.name && f.lastName === field.lastName)
            if(exact) {
                // const match = lastField.find(f => f !== exact && f.name === field.lastName)
                // if (match) {
                //     throw new Error(`Field ${nextTable.name}:${field.name} - Duplicate field name`)
                // }
                lastField = [exact]
                cont = true
            }
            // another case. when swapping 2 field names, this would be true, but this should be supported
            if(!cont && field.lastName && lastField.length === 2){
                const match = lastField.filter(f=>f.name === field.lastName)
                if(match.length === 1) {
                    cont = true
                    lastField = match
                }
            }
            if(!cont) throw new Error(`Field ${nextTable.name}:${field.name} - Duplicate field name`)
        }
        const res1 = validateFieldChange(field, lastField[0], nextTable.name, nextSettings)
        if(res1.create) res.create.push(res1.create)
        if(res1.drop) res.drop.push(res1.drop)
        if(res1.alter) res.alter.push(res1.alter)
    }
    for (const field of lastTable?.fields||[]) {
        let nextField = nextTable.fields.filter(f=>f.name === field.name || f.lastName === field.name)
        if(nextField.length > 1) {
            // there is a case here we need to handle. when swapping 2 field names, this would be true, but this should be supported
            let cont = false
            if(nextField.length === 2){
                nextField = nextField.filter(f=>f.lastName === field.name)
                if(nextField.length === 1) {
                    // only if the field is new or changing...
                    if(res.create.includes(nextField[0]) || res.alter.find(a=>a[0] === nextField[0]))
                        cont = true
                }
            }

            if(!cont) throw new Error(`Field ${nextTable.name}:${field.name} - Duplicate field name`)
        }
        if(!nextField.length){ // deleted field
            const res1 = validateFieldChange(undefined, field, nextTable.name)
            if(res1.create) res.create.push(res1.create)
            if(res1.drop) res.drop.push(res1.drop)
            if(res1.alter) res.alter.push(res1.alter)
        }
    }

    if(nextTable.indexes) {
        for (const index of nextTable.indexes) {
            const last = lastTable?.indexes?.find(i=>indexName(i).name === indexName(index).name)
            const changed = !last || JSON.stringify(index) !== JSON.stringify(last)
            if(changed) {
                res.indexes.create.push(index)
                if(last) res.indexes.drop.push(last)
            }
            // todo check if body only has columns and tables that are allowed
        }
    }
    if(lastTable?.indexes) {
        for (const index of lastTable?.indexes || []) {
            const next = nextTable.indexes?.find(i => indexName(i).name === indexName(index).name)
            if (!next) {
                res.indexes.drop.push(index)
            }
        }
    }

    if(nextTable.triggers) {
        for (const trigger of nextTable.triggers) {
            const last = lastTable?.triggers?.find(i=>i.name === trigger.name)
            const changed = !last || JSON.stringify(trigger) !== JSON.stringify(last)
            if(changed) {
                res.triggers.create.push(trigger)
                if(last) res.triggers.drop.push(last)
            }
            // todo check if body only has columns and tables that are allowed
        }
    }
    if(lastTable?.triggers) {
        for (const trigger of lastTable?.triggers || []) {
            const next = nextTable.triggers?.find(i => i.name === trigger.name)
            if (!next) {
                res.triggers.drop.push(trigger)
            }
        }
    }

    // if(res.drop.length){
    //     if(res.create.length || res.alter.length){
    //         throw new Error(`Field ${nextTable.name}:${res.drop[0].name} - Field cannot be dropped - todo: right now it's not checked if the field is renamed or dropped.`)
    //     }
    // }

    if(JSON.stringify(nextTable.fullTextSearch ?? {}) !== JSON.stringify(lastTable?.fullTextSearch ?? {})) {
        res.fts = true
    }
    if(nextTable.fullTextSearch){
        if(!nextTable.fullTextSearch.fields.length) throw new Error(`Table ${nextTable.name} - Full text search fields must be set`)
        const invalidFields = nextTable.fullTextSearch.fields.filter(f=>!nextTable.fields.find(f2=>f2.name === f))
        if(invalidFields.length) throw new Error(`Table ${nextTable.name} - Invalid full text search fields - ${invalidFields.join(', ')}`)
        if(nextTable.fullTextSearch.tokenize && !['unicode61', 'ascii', 'porter', 'trigram'].includes(nextTable.fullTextSearch.tokenize)) {
            throw new Error(`Table ${nextTable.name} - Invalid tokenize value - ${nextTable.fullTextSearch.tokenize}`)
        }
        if(!nextTable.fullTextSearch.contentless && nextTable.fullTextSearch.content_rowid) {
            throw new Error(`Table ${nextTable.name} - content_rowid must not be set when contentless is false`)
        }
        if(nextTable.fullTextSearch.content_rowid){
            const field = nextTable.fields.find(f=>f.name === nextTable.fullTextSearch!.content_rowid)
            if(!field) throw new Error(`Table ${nextTable.name} - content_rowid field not found - ${nextTable.fullTextSearch!.content_rowid}`)
            if(field.sqlType !== 'integer') throw new Error(`Table ${nextTable.name} - content_rowid field must be integer`)
            if(field.foreignKey) throw new Error(`Table ${nextTable.name} - content_rowid field cannot have foreign key`)
            // todo should be primary?
        }
    }

    const extensions = nextTable.extensions
    for (const extension of extensions) {
        const parser = tableExtensionSchemas[extension.name as keyof typeof tableExtensionSchemas]
        const parsed = parser.parse(extension)
        // todo parse rules and check if they are valid
    }

    if(!lastTable) return {create: nextTable}
    return {alter: [nextTable, lastTable, res] as AlterTable}
}


export function isTableFieldUnique(f: TableFieldData, t: TableData){
    return f.unique || f.primary || !!t.indexes?.find(i=>{
        if(!i.unique) return false
        const fields = Array.isArray(i.fields) ? i.fields : [i.fields]
        // split because it can have collate...
        return !!fields.find(f1=>f1.split(' ')[0] === f.name)
    })
}
