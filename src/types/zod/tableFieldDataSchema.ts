import {z} from 'zod';
import {TableFieldDataType, TableFieldSqlDataType, TableFieldSqlDataType0, TableFieldSqlDataType1} from '../dataTypes';

import {zSQLQueryOrLiteral} from './sqlSchemas'
import {sqlDataTypeAliases, supportedTypesForSql} from './dataTypesSchemas'

export const zForeignKeyAction = z.enum(['SET NULL', 'SET DEFAULT', 'CASCADE', 'RESTRICT', 'NO ACTION'])

export const tableFieldDataSchema = z.object({
    name: z.string(),
    sqlType: z.string().transform(v => v.toLowerCase()).pipe(z.nativeEnum(TableFieldSqlDataType0).or(z.nativeEnum(TableFieldSqlDataType1))),
    type: z.nativeEnum(TableFieldDataType),
    usage: z.string().optional(),
    primary: z.boolean().optional(),
    autoIncrement: z.boolean().optional(),
    unique: z.boolean().optional(),
    notNull: z.boolean().optional(),
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
    noUpdate: z.boolean().optional(),
    noInsert: z.boolean().optional(),
    noSelect: z.boolean().optional(),
    lastName: z.string().optional(),
}).superRefine((data, ctx) => {
    const sqlBase = sqlDataTypeAliases[data.sqlType as TableFieldSqlDataType]
    if (sqlBase) {
        const supported = supportedTypesForSql[sqlBase]
        if (!supported.includes(data.type as TableFieldDataType)) {
            ctx.addIssue({code: "custom", message: `Field ${data.name} - Invalid type '${data.type}' for sqlType '${data.sqlType}', must be one of [${supported.join(', ')}]`, path: ['type']})
        }
    }
})
