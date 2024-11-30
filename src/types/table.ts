import {AlterField, TableFieldData, tableFieldDataSchema, validateFieldChange} from "./field";
import {z} from 'zod'
import {tableColumnNameSchema} from './sql'
import {DatabaseSettings} from './config'
import {TableFieldUsageRecord} from '../worker/usages'
import {tableExtensionSchemas} from './tableExtensions'

export interface TableData<TF=TableFieldData, TE=TableExtensionData>{
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
    fields: TF[]

    /**
     * if true, record_uid will be set automatically to uuidv4(when using insert route). type must be text
     */
    autoSetUid?: boolean

    extensions: TE[]

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
    autoSetUid: z.coerce.boolean().optional(),
    extensions: z.array(z.record(z.any()).and(z.object({name: z.string()}))),
    lastName: tableColumnNameSchema.optional(),
})

// [nextTable, lastTable, fieldChanges]
export type AlterTable = [TableData, TableData, {create: TableFieldData[], drop: TableFieldData[], alter: AlterField[]}]
export function validateTableChange(nextTable: TableData|undefined, lastTable: TableData|undefined, nextSettings?: DatabaseSettings) {
    if(!nextTable){
        if(!lastTable) return {}
        // todo handle dropped table like deleting files from r2, taking backup etc
        // throw new Error('not implemented')
        return {drop: lastTable}
    }
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

    const res: AlterTable[2] = {create: [], drop: [], alter: []}

    // todo improve lastName logic using multiple passes.
    for (const field of nextTable.fields) {
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

    // if(res.drop.length){
    //     if(res.create.length || res.alter.length){
    //         throw new Error(`Field ${nextTable.name}:${res.drop[0].name} - Field cannot be dropped - todo: right now it's not checked if the field is renamed or dropped.`)
    //     }
    // }

    const extensions = nextTable.extensions
    for (const extension of extensions) {
        const parser = tableExtensionSchemas[extension.name as keyof typeof tableExtensionSchemas]
        const parsed = parser.parse(extension)
    }

    if(!lastTable) return {create: nextTable}
    return {alter: [nextTable, lastTable, res] as AlterTable}
}

