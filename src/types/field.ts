import {TableFieldDataType0, TableFieldSqlDataType} from './dataTypes'
import {SQLLiteral, SQLQuery} from './sql'
import {TableFieldUsage} from '../worker/usages'

export interface TableFieldData<
    NAME = string,
    TYPE extends TableFieldDataType0|string = TableFieldDataType0|string,
    SQLTYPE extends TableFieldSqlDataType|string = TableFieldSqlDataType|string,
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

// [new field, last field]
export type AlterField = [TableFieldData, TableFieldData]

