import {DatabaseSettings} from '../config';
import {jsonStringify} from '../../utils/string';
import {
    TableFieldDataType,
    TableFieldSqlDataType
} from '../dataTypes';
import {AlterField, TableFieldData} from '../field';
import {SQLLiteral, SQLQuery} from '../sql'
import {literalToQuery, logSQLQuery} from '../../sql/build/query'
import {
    dataTypeToSqlDataType,
    sqlDataTypeAliases,
    sqlDataTypeToDataTypeDefaults,
    supportedTypesForSql
} from '../zod/dataTypesSchemas'
import {throwValidationError} from '../../utils/zod'

const allowFieldSchemaChange = true

export function validateFieldChange(field: TableFieldData | undefined, lastField: TableFieldData | undefined, tableName: string, settings?: DatabaseSettings, path: (string | number)[] = ['table']) {
    const fieldPath = field ? [...path, 'fields', field.name] : (lastField ? [...path, 'fields', lastField.name] : [...path, 'fields'])

    if (!field) {
        if (!lastField) return {}
        // todo handle dropped field

        // system fields. user must uncheck usage then delete field.
        if (lastField.usage) throwValidationError(`Field cannot be dropped - ${lastField.usage} usage exists`, ...fieldPath)

        // check if foreign key is used in other tables
        const fkCheck = settings?.tables.find(t => t.fields.find(f => f.foreignKey && (f.foreignKey.table === tableName && f.foreignKey.column === lastField.name)))
        if (fkCheck) throwValidationError(`Field cannot be dropped - used in ${fkCheck.name}`, ...fieldPath)

        // check if field is used in full text search
        const ftCheck = settings?.tables.find(t => t.name === tableName && t.fullTextSearch?.fields.includes(lastField.name))
        if (ftCheck) throwValidationError(`Field cannot be dropped - used in full text search`, ...fieldPath)

        return {drop: lastField}
    }

    if (lastField && jsonStringify(field) === jsonStringify(lastField)) return {}

    // @ts-ignore todo is this required if we are validating with zod
    field.sqlType = field.sqlType.toLowerCase()
    if (!field.type && !field.sqlType) {
        throwValidationError(`type or sqlType is required`, ...fieldPath)
    }
    if (field.sqlType && !field.type) {
        field.type = sqlDataTypeToDataTypeDefaults[field.sqlType as TableFieldSqlDataType];
        if (!field.type) throwValidationError(`Unable to determine type. Unknown type for sqlType - ${field.sqlType}`, ...fieldPath, 'sqlType')
    }
    if (field.type && !field.sqlType) {
        field.sqlType = dataTypeToSqlDataType[field.type as TableFieldDataType]
        if (!field.sqlType) throwValidationError(`Unable to determine sqlType. Unknown sqlType for type - ${field.type}`, ...fieldPath, 'type')
    }

    const sqlBase = sqlDataTypeAliases[field.sqlType as TableFieldSqlDataType]
    if (!sqlBase) throwValidationError(`Unknown sqlType - ${field.sqlType}`, ...fieldPath, 'sqlType')

    const supportedTypes = supportedTypesForSql[sqlBase]
    if (!supportedTypes.includes(field.type as TableFieldDataType)) {
        throwValidationError(`Invalid type for type - ${field.type} not in [${supportedTypes.join(', ')}]`, ...fieldPath, 'type')
    }
    if (field.foreignKey && settings) {
        // check if the other table and column etc exists. it needs to be done everytime so we find issues with this before generting migrations
        const table2 = settings.tables.find(t => t.name === field.foreignKey!.table)
        const field2 = table2?.fields.find(f => f.name === field.foreignKey!.column)
        if (!field2) throwValidationError(`Foreign key field not found - ${field.foreignKey!.table}.${field.foreignKey!.column}`, ...fieldPath, 'foreignKey')
        if (field2.sqlType !== field.sqlType) throwValidationError(`Foreign key field sqlType mismatch - ${field.sqlType} !== ${field2.sqlType}`, ...fieldPath, 'foreignKey')
    }

    // todo should we do usages check like created, updated should be date/text type etc?

    if (!lastField) {
        // todo handle field creation

        if (field.default !== undefined) {
            // todo try to parse and check valid sql string
        }
        if (field.check) {
            // todo try to parse and check valid sql string
        }
        return {create: field}
    }

    // if (field.name !== lastField.name) throwValidationError(`Field name cannot be changed - ${field.name} !== ${lastField.name}`, ...fieldPath)
    // if (field.type !== lastField.type) throwValidationError(`Field type cannot be changed - ${field.type} !== ${lastField.type}`, ...fieldPath)
    if (field.sqlType !== lastField.sqlType) {
        // todo check if data from one type can be converted to another automatically
        if (!allowFieldSchemaChange) throwValidationError(`Field sqlType cannot be changed - ${field.sqlType} !== ${lastField.sqlType}`, ...fieldPath, 'sqlType')
    }
    if (field.primary !== lastField.primary) if (!allowFieldSchemaChange) throwValidationError(`Field primary cannot be changed - ${field.primary} !== ${lastField.primary}`, ...fieldPath, 'primary')
    if (field.autoIncrement !== lastField.autoIncrement) if (!allowFieldSchemaChange) throwValidationError(`Field autoIncrement cannot be changed - ${field.autoIncrement} !== ${lastField.autoIncrement}`, ...fieldPath, 'autoIncrement')
    if (field.unique !== lastField.unique) if (!allowFieldSchemaChange) throwValidationError(`Field unique cannot be changed - ${field.unique} !== ${lastField.unique}`, ...fieldPath, 'unique')
    if (field.notNull !== lastField.notNull) if (!allowFieldSchemaChange) throwValidationError(`Field notNull cannot be changed - ${field.notNull} !== ${lastField.notNull}`, ...fieldPath, 'notNull')
    if (buildSql(field.default) !== buildSql(lastField.default)) {
        // todo try to parse and check valid sql string
        if (!allowFieldSchemaChange) throwValidationError(`Field default cannot be changed - ${buildSql(field.default)} !== ${buildSql(lastField.default)}`, ...fieldPath, 'default')
    }
    if (buildSql(field.check) !== buildSql(lastField.check)) {
        // todo try to parse and check valid sql string
        if (!allowFieldSchemaChange) throwValidationError(`Field default cannot be changed - ${buildSql(field.check)} !== ${buildSql(lastField.check)}`, ...fieldPath, 'check')
    }
    const foreignKey = jsonStringify(field.foreignKey)
    const lastForeignKey = jsonStringify(lastField.foreignKey)
    if (foreignKey !== lastForeignKey) {
        let trivial = false
        if (field.foreignKey && lastField.foreignKey && field.foreignKey.table !== lastField.foreignKey.table) {
            const fkTable = settings?.tables.find(t => t.name === field.foreignKey!.table)
            if (!fkTable) throwValidationError(`Foreign key table not found - ${field.foreignKey!.table}`, ...fieldPath, 'foreignKey', 'table')
            if (fkTable.lastName === lastField.foreignKey.table) trivial = true
        }
        if (!trivial) if (!allowFieldSchemaChange)
            throwValidationError(`Field foreignKey cannot be changed - ${foreignKey} !== ${lastForeignKey}`, ...fieldPath, 'foreignKey')
    }
    // if (field.noInsert !== lastField.noInsert) throwValidationError(`Field noInsert cannot be changed - ${field.noInsert} !== ${lastField.noInsert}`, ...fieldPath, 'noInsert')
    // if (field.noUpdate !== lastField.noUpdate) throwValidationError(`Field noUpdate cannot be changed - ${field.noUpdate} !== ${lastField.noUpdate}`, ...fieldPath, 'noUpdate')

    // if (field.usage !== lastField.usage) throwValidationError(`Field usage cannot be changed - ${field.usage} !== ${lastField.usage}`, ...fieldPath, 'usage')

    const changes = jsonStringify(field) !== jsonStringify(lastField)
    return changes ? {alter: [field, lastField] as AlterField} : {}
}

// todo
function buildSql(q?: SQLLiteral|SQLQuery|string){
    if(typeof q === 'string'){

    }
    return q ? logSQLQuery(literalToQuery(typeof q === 'string' ? {q} : q, false)) : undefined
}
