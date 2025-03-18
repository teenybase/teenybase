import {z} from 'zod'
import {
    dataTypeToSqlDataType,
    sqlDataTypeAliases,
    sqlDataTypeToDataTypeDefaults,
    supportedTypesForSql,
    TableFieldDataType, TableFieldDataType0,
    TableFieldSqlDataType,
    TableFieldSqlDataType0,
    TableFieldSqlDataType1
} from './dataTypes'
import {DatabaseSettings} from './config'
import {literalToQuery, logSQLQuery} from '../sql/build/query'
import {SQLLiteral, SQLQuery, zSQLQueryOrLiteral} from './sql'
import {TableFieldUsage} from '../worker/usages'

export interface TableFieldData<
    NAME = string,
    TYPE extends TableFieldDataType0 = TableFieldDataType0,
    SQLTYPE extends TableFieldSqlDataType = TableFieldSqlDataType,
    USAGE extends TableFieldUsage|string = TableFieldUsage|string
> {
    name: NAME
    sqlType: SQLTYPE // sql
    type: TYPE // ours
    usage?: USAGE
    // other data

    primary?: boolean,
    autoIncrement?: boolean,
    unique?: boolean,
    notNull?: boolean,
    default?: SQLLiteral | SQLQuery | string, // raw sql if string
    check?: SQLLiteral | SQLQuery | string, // raw sql if string
    foreignKey?: FieldForeignKey,
    collate?: 'BINARY' | 'NOCASE' | 'RTRIM' | string; // todo
    // updateTriggers?: Omit<SQLTrigger, 'updateOf' | 'event'>[],

    noUpdate?: boolean // value in this field cannot be updated.
    noInsert?: boolean // value in this field cannot be inserted.
    noSelect?: boolean // value in this field cannot be get(except for admins).

    // this can be set to/after rename a field
    lastName?: string
    // todo
    // presentable
}

export function tableField<
    NAME = string,
    TYPE extends TableFieldDataType0 = TableFieldDataType0,
    SQLTYPE extends TableFieldSqlDataType = TableFieldSqlDataType,
    USAGE extends TableFieldUsage|string = TableFieldUsage|string
>(name: NAME, type: TYPE, sqlType: SQLTYPE, data: Omit<TableFieldData<never, never, never, USAGE>, 'name' | 'type' | 'sqlType'>): TableFieldData<NAME, TYPE, SQLTYPE, USAGE> {
    return { name, type, sqlType, ...data }
}

export type FieldForeignKey = {
    table: string,
    column: string,
    onUpdate?: ForeignKeyAction,
    onDelete?: ForeignKeyAction,

    // todo
    // match?: string,
    // defer
}
export type ForeignKeyAction = 'SET NULL' | 'SET DEFAULT' | 'CASCADE' | 'RESTRICT' | 'NO ACTION' | string
export const zForeignKeyAction = z.enum(['SET NULL', 'SET DEFAULT', 'CASCADE', 'RESTRICT', 'NO ACTION'])

export const tableFieldDataSchema = z.object({
    name: z.string(),
    sqlType: z.nativeEnum(TableFieldSqlDataType0).or(z.nativeEnum(TableFieldSqlDataType1)),
    type: z.nativeEnum(TableFieldDataType),
    usage: z.string().optional(),
    primary: z.coerce.boolean().optional(),
    autoIncrement: z.coerce.boolean().optional(),
    unique: z.coerce.boolean().optional(),
    notNull: z.coerce.boolean().optional(),
    collate: z.string().optional(), // todo enum
    default: zSQLQueryOrLiteral.or(z.string()).optional(),
    check: zSQLQueryOrLiteral.or(z.string()).optional(),
    foreignKey: z.object({
        table: z.string(),
        column: z.string(),
        onUpdate: zForeignKeyAction.optional(),
        onDelete: zForeignKeyAction.optional(),
    }).optional(),
    // updateTriggers: z.array(zSQLTrigger.omit({updateOf: true, event: true})).optional(),
    noUpdate: z.coerce.boolean().optional(),
    noInsert: z.coerce.boolean().optional(),
    noSelect: z.coerce.boolean().optional(),
    lastName: z.string().optional(),
})

const allowFieldSchemaChange = true

// [new field, last field]
export type AlterField = [TableFieldData, TableFieldData]
export function validateFieldChange(field: TableFieldData|undefined, lastField: TableFieldData|undefined, tableName: string, settings?: DatabaseSettings){
    if(!field){
        if(!lastField) return {}
        // todo handle dropped field

        // system fields. user must uncheck usage then delete field.
        if(lastField.usage) throw new Error(`Field ${tableName}:${lastField.name} - Field cannot be dropped - ${lastField.usage} usage exists`)

        // check if foreign key is used in other tables
        const fkCheck = settings?.tables.find(t=>t.fields.find(f=>f.foreignKey && (f.foreignKey.table === tableName && f.foreignKey.column === lastField.name)))
        if(fkCheck) throw new Error(`Field ${tableName}:${lastField.name} - Field cannot be dropped - used in ${fkCheck.name}`)

        // check if field is used in full text search
        const ftCheck = settings?.tables.find(t=>t.name === tableName && t.fullTextSearch?.fields.includes(lastField.name))
        if(ftCheck) throw new Error(`Field ${tableName}:${lastField.name} - Field cannot be dropped - used in full text search`)

        return {drop: lastField}
    }

    if(lastField && JSON.stringify(field) === JSON.stringify(lastField)) return {}

    const fPrefix = `Table Field ${tableName}:${field.name} - `
    // @ts-ignore todo is this required if we are validating with zod
    field.sqlType = field.sqlType.toLowerCase()
    if(!field.type && !field.sqlType){
        throw new Error(fPrefix + `type or sqlType is required`)
    }
    if(field.sqlType && !field.type) {
        field.type = sqlDataTypeToDataTypeDefaults[field.sqlType as TableFieldSqlDataType];
        if(!field.type) throw new Error(fPrefix + `Unable to determine type. Unknown type for sqlType - ${field.sqlType}`)
    }
    if(field.type && !field.sqlType){
        field.sqlType = dataTypeToSqlDataType[field.type as TableFieldDataType]
        if(!field.sqlType) throw new Error(fPrefix + `Unable to determine sqlType. Unknown sqlType for type - ${field.type}`)
    }

    const sqlBase = sqlDataTypeAliases[field.sqlType as TableFieldSqlDataType]
    if(!sqlBase) throw new Error(fPrefix + `Unknown sqlType - ${field.sqlType}`)

    const supportedTypes = supportedTypesForSql[sqlBase]
    if(!supportedTypes.includes(field.type as TableFieldDataType)){
        throw new Error(fPrefix + `Invalid type for type - ${field.type} not in [${supportedTypes.join(', ')}]`)
    }
    if(field.foreignKey && settings){
        // check if the other table and column etc exists. it needs to be done everytime so we find issues with this before generting migrations
        const table2 = settings.tables.find(t=>t.name === field.foreignKey!.table)
        const field2 = table2?.fields.find(f=>f.name === field.foreignKey!.column)
        if(!field2) throw new Error(fPrefix + `Foreign key field not found - ${field.foreignKey!.table}.${field.foreignKey!.column}`)
        if(field2.sqlType !== field.sqlType) throw new Error(fPrefix + `Foreign key field sqlType mismatch - ${field.sqlType} !== ${field2.sqlType}`)
    }

    // todo should we do usages check like created, updated should be date/text type etc?

    if (!lastField) {
        // todo handle field creation

        if(field.default !== undefined){
            // todo try to parse and check valid sql string
        }
        if(field.check){
            // todo try to parse and check valid sql string
        }
        return {create: field}
    }

    // if (field.name !== lastField.name) throw new Error(fPrefix + `Field name cannot be changed - ${field.name} !== ${lastField.name}`)
    // if (field.type !== lastField.type) throw new Error(fPrefix + `Field type cannot be changed - ${field.type} !== ${lastField.type}`)
    if (field.sqlType !== lastField.sqlType) {
        // todo check if data from one type can be converted to another automatically
        if(!allowFieldSchemaChange) throw new Error(fPrefix + `Field sqlType cannot be changed - ${field.sqlType} !== ${lastField.sqlType}`)
    }
    if (field.primary !== lastField.primary) if(!allowFieldSchemaChange) throw new Error(fPrefix + `Field primary cannot be changed - ${field.primary} !== ${lastField.primary}`)
    if (field.autoIncrement !== lastField.autoIncrement) if(!allowFieldSchemaChange) throw new Error(fPrefix + `Field autoIncrement cannot be changed - ${field.autoIncrement} !== ${lastField.autoIncrement}`)
    if (field.unique !== lastField.unique) if(!allowFieldSchemaChange) throw new Error(fPrefix + `Field unique cannot be changed - ${field.unique} !== ${lastField.unique}`)
    if (field.notNull !== lastField.notNull) if(!allowFieldSchemaChange) throw new Error(fPrefix + `Field notNull cannot be changed - ${field.notNull} !== ${lastField.notNull}`)
    if (buildSql(field.default) !== buildSql(lastField.default)) {
        // todo try to parse and check valid sql string
        if(!allowFieldSchemaChange) throw new Error(fPrefix + `Field default cannot be changed - ${buildSql(field.default)} !== ${buildSql(lastField.default)}`)
    }
    if (buildSql(field.check) !== buildSql(lastField.check)) {
        // todo try to parse and check valid sql string
        if(!allowFieldSchemaChange) throw new Error(fPrefix + `Field default cannot be changed - ${buildSql(field.check)} !== ${buildSql(lastField.check)}`)
    }
    const foreignKey = JSON.stringify(field.foreignKey)
    const lastForeignKey = JSON.stringify(lastField.foreignKey)
    if (foreignKey !== lastForeignKey) {
        let trivial = false
        if(field.foreignKey && lastField.foreignKey && field.foreignKey.table !== lastField.foreignKey.table){
            const fkTable = settings?.tables.find(t=>t.name === field.foreignKey!.table)
            if(!fkTable) throw new Error(fPrefix + `Foreign key table not found - ${field.foreignKey!.table}`)
            if(fkTable.lastName === lastField.foreignKey.table) trivial = true
        }
        if(!trivial) if(!allowFieldSchemaChange)
            throw new Error(fPrefix + `Field foreignKey cannot be changed - ${foreignKey} !== ${lastForeignKey}`)
    }
    // if (field.noInsert !== lastField.noInsert) throw new Error(`Field noInsert cannot be changed - ${field.noInsert} !== ${lastField.noInsert}`)
    // if (field.noUpdate !== lastField.noUpdate) throw new Error(`Field noUpdate cannot be changed - ${field.noUpdate} !== ${lastField.noUpdate}`)

    // if (field.usage !== lastField.usage) throw new Error(`Field usage cannot be changed - ${field.usage} !== ${lastField.usage}`)

    const changes = JSON.stringify(field) !== JSON.stringify(lastField)
    return changes ? {alter: [field, lastField] as AlterField} : {}
}

// todo
function buildSql(q?: SQLLiteral|SQLQuery|string){
    if(typeof q === 'string'){

    }
    return q ? logSQLQuery(literalToQuery(typeof q === 'string' ? {q} : q, false)) : undefined
}
