import {HTTPException} from 'hono/http-exception'
import {FieldForeignKey, TableFieldData} from '../../types/field'
import {
    TableFieldDataType,
    TableFieldSqlDataType
} from '../../types/dataTypes'
import {$Database} from '../../worker'
import {TableRulesExtensionData} from '../../types/tableExtensions'
import {TableData} from '../../types/table'
import {sqlRaw} from '../../types/config/sqlUtils';
import {sqlDataTypeAliases, sqlDataTypeToDataTypeDefaults, supportedTypesForSql} from '../../types/zod/dataTypesSchemas'

export interface TableInfo{
    name: string,
    fields: TableFieldData[]
    logs: string[]
}
interface TableInfoStmtRes {
    name: string,
    type: string,
    notnull: number,
    dflt_value: string,
    // check: string, -- not possible
    pk: number,
    fk_id: number,
    fk_table: string,
    fk_column: string,
    fk_on_update: string,
    fk_on_delete: string,
    fk_match: string,
}
function tableInfoStmt(name: string){
    return `SELECT
    pti.*,
    fkl.id AS fk_id,
    fkl."table" AS fk_table,
    fkl."to" AS fk_column,
    fkl."on_update" AS fk_on_update,
    fkl."on_delete" AS fk_on_delete,
    fkl."match" AS fk_match
FROM
    pragma_table_info('${name}') pti
LEFT JOIN
    pragma_foreign_key_list('${name}') fkl ON pti.name = fkl."from"
`
}
export async function getTableInfo(db: $Database, collections: { name: string, fields?: TableFieldData[] }[]): Promise<(TableInfo)[]> {
    const res = await db.rawSQLTransaction<TableInfoStmtRes>(collections.map(col => ({q:tableInfoStmt(col.name), v:[]}))).run()
    if(!res) throw new HTTPException(500, {message: 'Error - Unable to get table info'})
    return res.map((r1, i) => {
        const results = r1
        let logs = [] as string[]
        return {
            name: collections[i].name,
            system: collections[i].name.startsWith('_') || collections[i].name.startsWith('sqlite_'),
            // ...collections[i],
            logs,
            fields: results.map((field) => {
                if (!field.name) {
                    logs.push(`Unknown field with no name`)
                    return null
                }
                const oldField = collections[i].fields?.find(f => f.name === field.name)
                const type = field.type.toLowerCase() as TableFieldSqlDataType
                let defType = (oldField?.type && supportedTypesForSql[sqlDataTypeAliases[type]].includes(TableFieldDataType[oldField.type as keyof typeof TableFieldDataType]))
                    ? oldField.type : sqlDataTypeToDataTypeDefaults[type]
                if(!defType) {
                    logs.push(`Unknown type ${type} for field ${field.name}`)
                    return null
                }
                const relation: FieldForeignKey|undefined = field.fk_column && field.fk_table ? {
                    table: field.fk_table,
                    column: field.fk_column,
                    onUpdate: field.fk_on_update?.toUpperCase() || undefined,
                    onDelete: field.fk_on_delete?.toUpperCase() || undefined,
                    // match: field.fk_match?.toUpperCase() || undefined, // todo
                } : undefined
                if(relation){
                    // todo only if one to one? and other checks?
                    defType = 'relation'
                }
                if(oldField?.foreignKey){
                    // todo check if relation matches
                }
                return {
                    ...oldField,
                    id: field.name,
                    sqlType: type,
                    type: defType,
                    primary: !!field.pk,
                    default: field.dflt_value ? sqlRaw(field.dflt_value) : undefined,
                    notNull: !!field.notnull,
                    name: field.name,
                    foreignKey: relation,
                } as TableFieldData
            }).filter(v => v) as TableFieldData[]
        }
    })
}

export async function getSQLiteSchema(db: $Database<any>){
    if(!db.auth.admin) throw new HTTPException(db.auth.uid ? 403 : 401, {message: 'Unauthorized'})
    const schema = await db.rawSQL<{
        name: string,
        tbl_name: string,
        type: string,
        sql: string
    }>({q: `SELECT * from sqlite_schema`, v: []}).run() ?? []

    const tableCheck = (r: any)=>{
        return r.type === 'table'
            // && !r.name.startsWith('_')
            && !r.name.startsWith('_cf')
            && !r.name.startsWith('sqlite_')
    }
    // console.log(schema)
    const tables = await getTableInfo(db, schema.filter(tableCheck).map(r => ({
        name: r.tbl_name,
        sql: r.sql,
        // fields: todo existing fields
    })))
    return tables.map(t => ({
        name: t.name,
        fields: t.fields,
        extensions: [{
            name: "rules",
            listRule: null,
            viewRule: null,
            createRule: null,
            deleteRule: null,
            updateRule: null,
        } as TableRulesExtensionData],
        // r2Base: t.name,
        autoSetUid: false, // todo if pk is text and not autoincrement etc
    } as TableData))
}
