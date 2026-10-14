import {z} from 'zod'
import {DatabaseSettings} from '../config';
import {jsonStringify} from '../../utils/string';
import {AlterField, TableFieldData} from '../field';
import {SQLLiteral, SQLQuery} from '../sql'
import {literalToQuery, logSQLQuery} from '../../sql/build/query'
import {
    dataTypeToSqlDataType,
    sqlDataTypeAliases,
    sqlDataTypeToDataTypeDefaults,
    supportedTypesForSql
} from "../zod/dataTypesSchemas";
import {TableFieldDataType, TableFieldSqlDataType} from "../dataTypes";

const allowFieldSchemaChange = true

export function validateFieldChange(field: TableFieldData | undefined, lastField: TableFieldData | undefined, tableName: string, settings?: DatabaseSettings, path: (string | number)[] = ['table']) {
    const fieldPath = field ? [...path, 'fields', field.name] : (lastField ? [...path, 'fields', lastField.name] : [...path, 'fields'])
    const issues: z.core.$ZodIssue[] = []
    const addIssue = (message: string, ...extra: (string | number)[]) =>
        issues.push({code: "custom", message, path: [...fieldPath, ...extra]})

    if (!field) {
        if (!lastField) return {}
        // todo handle dropped field

        // system fields. user must uncheck usage then delete field.
        if (lastField.usage) addIssue(`Field cannot be dropped - ${lastField.usage} usage exists`)

        // check if foreign key is used in other tables
        const fkCheck = settings?.tables.find(t => t.fields.find(f => f.foreignKey && (f.foreignKey.table === tableName && f.foreignKey.column === lastField.name)))
        if (fkCheck) addIssue(`Field cannot be dropped - used in ${fkCheck.name}`)

        // check if field is used in full text search
        const ftCheck = settings?.tables.find(t => t.name === tableName && t.fullTextSearch?.fields.includes(lastField.name))
        if (ftCheck) addIssue(`Field cannot be dropped - used in full text search`)

        if (issues.length) throw new z.ZodError(issues)
        return {drop: lastField}
    }

    if (lastField && jsonStringify(field) === jsonStringify(lastField)) return {}

    if (!field.sqlType && !field.type) {
        addIssue(`type or sqlType is required`)
        if (issues.length) throw new z.ZodError(issues)
    }
    if (field.sqlType) field.sqlType = field.sqlType.toLowerCase() as typeof field.sqlType
    if (field.sqlType && !field.type) {
        field.type = sqlDataTypeToDataTypeDefaults[field.sqlType as TableFieldSqlDataType];
        if (!field.type) addIssue(`Unable to determine type. Unknown type for sqlType - ${field.sqlType}`, 'sqlType')
    }
    if (field.type && !field.sqlType) {
        field.sqlType = dataTypeToSqlDataType[field.type as TableFieldDataType]
        if (!field.sqlType) addIssue(`Unable to determine sqlType. Unknown sqlType for type - ${field.type}`, 'type')
    }

    const sqlBase = sqlDataTypeAliases[field.sqlType as TableFieldSqlDataType]
    if (!sqlBase) addIssue(`Unknown sqlType - ${field.sqlType}`, 'sqlType')

    const supportedTypes = supportedTypesForSql[sqlBase]
    if (!supportedTypes.includes(field.type as TableFieldDataType)) {
        addIssue(`Invalid type for type - ${field.type} not in [${supportedTypes.join(', ')}]`, 'type')
    }
    if (field.foreignKey && settings) {
        // check if the other table and column etc exists. it needs to be done everytime so we find issues with this before generting migrations
        const table2 = settings.tables.find(t => t.name === field.foreignKey!.table)
        const field2 = table2?.fields.find(f => f.name === field.foreignKey!.column)
        if (!field2) addIssue(`Foreign key field not found - ${field.foreignKey!.table}.${field.foreignKey!.column}`, 'foreignKey')
        else {
            if (field2.sqlType !== field.sqlType) addIssue(`Foreign key field sqlType mismatch - ${field.sqlType} !== ${field2.sqlType}`, 'foreignKey')
        }
    }

    // todo should we do usages check like created, updated should be date/text type etc?

    if (!lastField) {
        // todo handle field creation

        if (field.default !== undefined) {
            // todo try to parse and check valid sql string
            if(typeof (field.default as SQLQuery).p === 'object' && Object.keys((field.default as SQLQuery).p!).length > 0)
                addIssue(`Not implemented - Default SQL query cannot have parameters - ${JSON.stringify((field.default as SQLQuery).p)}`, 'default')
        }
        if (field.check) {
            // todo try to parse and check valid sql string
            if(typeof (field.check as SQLQuery).p === 'object' && Object.keys((field.check as SQLQuery).p!).length > 0)
                addIssue(`Not implemented - Check SQL query cannot have parameters - ${JSON.stringify((field.check as SQLQuery).p)}`, 'check')

        }

        if (issues.length) throw new z.ZodError(issues)

        return {create: field}
    }

    // if (field.name !== lastField.name) addIssue(`Field name cannot be changed - ${field.name} !== ${lastField.name}`)
    // if (field.type !== lastField.type) addIssue(`Field type cannot be changed - ${field.type} !== ${lastField.type}`)
    if (field.sqlType !== lastField.sqlType) {
        // todo check if data from one type can be converted to another automatically
        if (!allowFieldSchemaChange) addIssue(`Field sqlType cannot be changed - ${field.sqlType} !== ${lastField.sqlType}`, 'sqlType')
    }
    if (field.primary !== lastField.primary) if (!allowFieldSchemaChange) addIssue(`Field primary cannot be changed - ${field.primary} !== ${lastField.primary}`, 'primary')
    if (field.autoIncrement !== lastField.autoIncrement) if (!allowFieldSchemaChange) addIssue(`Field autoIncrement cannot be changed - ${field.autoIncrement} !== ${lastField.autoIncrement}`, 'autoIncrement')
    if (field.unique !== lastField.unique) if (!allowFieldSchemaChange) addIssue(`Field unique cannot be changed - ${field.unique} !== ${lastField.unique}`, 'unique')
    if (field.notNull !== lastField.notNull) if (!allowFieldSchemaChange) addIssue(`Field notNull cannot be changed - ${field.notNull} !== ${lastField.notNull}`, 'notNull')
    if (buildSql(field.default) !== buildSql(lastField.default)) {
        // todo try to parse and check valid sql string
        if (!allowFieldSchemaChange) addIssue(`Field default cannot be changed - ${buildSql(field.default)} !== ${buildSql(lastField.default)}`, 'default')
    }
    if (buildSql(field.check) !== buildSql(lastField.check)) {
        // todo try to parse and check valid sql string
        if (!allowFieldSchemaChange) addIssue(`Field default cannot be changed - ${buildSql(field.check)} !== ${buildSql(lastField.check)}`, 'check')
    }
    const foreignKey = jsonStringify(field.foreignKey)
    const lastForeignKey = jsonStringify(lastField.foreignKey)
    if (foreignKey !== lastForeignKey) {
        let trivial = false
        if (field.foreignKey && lastField.foreignKey && field.foreignKey.table !== lastField.foreignKey.table) {
            const fkTable = settings?.tables.find(t => t.name === field.foreignKey!.table)
            if (!fkTable) addIssue(`Foreign key table not found - ${field.foreignKey!.table}`, 'foreignKey', 'table')
            else {
                if (fkTable.lastName === lastField.foreignKey.table) trivial = true
            }
        }
        if (!trivial) if (!allowFieldSchemaChange)
            addIssue(`Field foreignKey cannot be changed - ${foreignKey} !== ${lastForeignKey}`, 'foreignKey')
    }
    // if (field.noInsert !== lastField.noInsert) addIssue(`Field noInsert cannot be changed - ${field.noInsert} !== ${lastField.noInsert}`, 'noInsert')
    // if (field.noUpdate !== lastField.noUpdate) addIssue(`Field noUpdate cannot be changed - ${field.noUpdate} !== ${lastField.noUpdate}`, 'noUpdate')

    // if (field.usage !== lastField.usage) addIssue(`Field usage cannot be changed - ${field.usage} !== ${lastField.usage}`, 'usage')

    if (issues.length) throw new z.ZodError(issues)
    const changes = jsonStringify(field) !== jsonStringify(lastField)
    return changes ? {alter: [field, lastField] as AlterField} : {}
}

// todo
function buildSql(q?: SQLLiteral|SQLQuery|string){
    if(typeof q === 'string'){

    }
    return q ? logSQLQuery(literalToQuery(typeof q === 'string' ? {q} : q, false)) : undefined
}
