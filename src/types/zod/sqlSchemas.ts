import {z} from 'zod';

export const sqlExprSchema = z.string().max(1000).regex(/^[a-zA-Z0-9_=\s():.*~%'"><!+\-&|@,\/\\${}]*$/, 'Invalid expression')
export const sqlExprSchemaRecord = z.record(z.string(), sqlExprSchema)
export const sqlValSchema = z.string().or(z.number()).or(z.boolean()).or(z.null())
// z.any() for File — z.instanceof(File) is incompatible with OpenAPI schema generation,
// and actual file validation is handled by multipart parsing, not zod.
// todo can we use something better than just z.any? or change it when parsing with openapi?
export const sqlValSchemaFile = z.boolean().or(z.string().or(z.number()).or(z.null()).or(z.any()))
export const sqlValSchemaRecord = z.record(z.string(), sqlValSchema)
export const sqlValSchema2 = sqlValSchema.or(sqlValSchemaRecord)
export const sqlValSchemaFile2 = z.record(z.string(), sqlValSchemaFile)
export const sqlValSchemaFile3 = sqlValSchemaFile2.or(z.array(sqlValSchemaFile2))
export const sqlColListSchema = z.string().regex(/^[a-zA-Z0-9_,\s]*$/).or(z.literal('*'))
export const sqlColListSchemaOrder = z.string().regex(/^[a-zA-Z0-9_,\s+-]*$/)
// for search query params
export const sqlColListSchema2 = z.array(sqlColListSchema).or(sqlColListSchema)
export const sqlColListSchemaOrder2 = z.array(sqlColListSchemaOrder).or(sqlColListSchemaOrder)
export const tableColumnNameSchema = z.string()
    .min(1).max(255)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Table/Column name must start with a letter or underscore and can only contain letters, numbers and underscores')
    //.or(z.literal('*')) // todo *

export const zSQLQuery = z.object({
    q: z.string(),
    p: z.record(z.string(), sqlValSchema2).optional()
})
export const zSQLLiteral = z.object({
    l: sqlValSchema2,
    key: z.string().optional()
})
export const zSQLQueryOrLiteral = zSQLQuery.or(zSQLLiteral)
export const zOnConflict = z.enum(['ABORT', 'FAIL', 'IGNORE', 'REPLACE', 'ROLLBACK'])
export const selectSchema = z.object({
    where: sqlExprSchema.optional(),
    limit: z.coerce.number().optional(),
    offset: z.coerce.number().optional(),
    order: sqlColListSchemaOrder2.optional(),
    sort: sqlColListSchemaOrder2.optional(), // alias for order (PocketBase convention)
    group: sqlColListSchema2.optional(),
    select: sqlExprSchema.or(z.array(sqlExprSchema)).optional(), // todo rename to fields in api v2
    distinct: z.boolean().or(z.enum(['true', '1', '']).transform(() => true)).or(z.enum(['false', '0']).transform(() => false)).optional(),

    // join: joinObjSchema2.array().optional(),
    // having: z.string().regex(/^[a-zA-Z0-9_=\s\(\)\.\*]*$/).optional(),
    // selectOption: z.string().optional(),
})
export const updateSchema = z.object({
    or: zOnConflict.optional(),
    set: z.record(z.string(), sqlExprSchema).optional(),
    setValues: z.record(z.string(), sqlValSchema).optional(),
    where: sqlExprSchema,
    returning: z.array(sqlExprSchema).or(sqlExprSchema).optional()
})
export const insertSchema = z.object({
    or: zOnConflict.optional(),
    values: sqlValSchemaRecord.or(z.array(sqlValSchemaRecord)).optional(),
    expr: sqlExprSchemaRecord.or(z.array(sqlExprSchemaRecord)).optional(),
    returning: z.array(sqlExprSchema).or(sqlExprSchema).optional(),
})
export const deleteSchema = z.object({
    where: sqlExprSchema,
    returning: z.array(sqlExprSchema).or(sqlExprSchema).optional(),
})
export const tableDeleteSchema = deleteSchema
export const tableInsertSchema = insertSchema.omit({values: true}).extend({values: sqlValSchemaFile3})
export const tableUpdateSchema = updateSchema.omit({setValues: true}).extend({setValues: sqlValSchemaFile2.optional()})
export const tableSelectSchema = selectSchema
export const tableViewSchema = selectSchema.pick({select: true, where: true})
export const tableEditSchema = z.object({
    setValues: sqlValSchemaFile2,
    or: updateSchema.shape.or.or(z.literal('INSERT')),
    returning: updateSchema.shape.returning
})
export const selectStatementSchema = tableSelectSchema.extend({
    type: z.literal('SELECT'),
    table: tableColumnNameSchema,
})
export const insertStatementSchema = insertSchema.extend({
    type: z.literal('INSERT'),
    table: tableColumnNameSchema,
})
export const updateStatementSchema = tableUpdateSchema.extend({
    type: z.literal('UPDATE'),
    table: tableColumnNameSchema,
})
export const deleteStatementSchema = tableDeleteSchema.extend({
    type: z.literal('DELETE'),
    table: tableColumnNameSchema,
})
export const zSQLIndex = z.object({
    name: tableColumnNameSchema.optional(),
    unique: z.boolean().optional(),
    // fields: tableColumnNameSchema.or(z.array(tableColumnNameSchema)),
    fields: z.string().or(z.array(z.string())),// fields can include collate also
    where: zSQLQuery.optional(),
})
export const zSQLTrigger = z.object({
    name: tableColumnNameSchema,
    event: z.enum(['INSERT', 'DELETE', 'UPDATE']),
    seq: z.enum(['BEFORE', 'AFTER', 'INSTEAD OF']).optional(),
    updateOf: tableColumnNameSchema.or(z.array(tableColumnNameSchema)).optional(),
    forEach: z.enum(['ROW']).optional(),
    body: zSQLQuery.or(z.array(zSQLQuery)),
    when: zSQLQuery.optional(),
})
// Typed schemas for sql-mode action queries (sql`` tagged templates produce {q}, sqlValue() produces {l})
const zSQLQueryObj = z.object({q: z.string(), p: z.record(z.string(), z.any()).optional()})
const zSQLLiteralObj = z.object({l: z.any(), key: z.string().optional()})
const zSQLQueryOrLiteralObj = zSQLQueryObj.or(zSQLLiteralObj)
const zSetValueRecord = z.record(z.string(), z.union([zSQLQueryOrLiteralObj, z.string()]))
const zSelectItem = z.string().or(z.object({q: z.string(), as: z.string()}))
const zReturningItem = z.string().or(z.object({q: z.string(), as: z.string()}))
const zTypedSelectQuery = z.object({
    type: z.literal('SELECT'),
    from: z.string().or(z.array(z.string())).optional(),
    selects: z.array(zSelectItem).optional(),
    distinct: z.boolean().optional(),
    where: zSQLQueryOrLiteralObj.optional(),
    orderBy: z.string().or(z.array(z.string())).optional(),
    groupBy: z.array(z.string()).optional(),
    limit: z.number().optional(),
    offset: z.number().optional(),
    params: z.record(z.string(), z.any()).optional(),
}).passthrough()
const zTypedUpdateQuery = z.object({
    type: z.literal('UPDATE'),
    table: z.string(),
    set: zSetValueRecord,
    where: zSQLQueryOrLiteralObj.optional(),
    returning: z.array(zReturningItem).optional(),
    or: zOnConflict.optional(),
    params: z.record(z.string(), z.any()).optional(),
}).passthrough()
const zTypedInsertQuery = z.object({
    type: z.literal('INSERT'),
    table: z.string(),
    values: zSetValueRecord.or(z.array(zSetValueRecord)),
    returning: z.array(zReturningItem).optional(),
    or: zOnConflict.optional(),
    params: z.record(z.string(), z.any()).optional(),
}).passthrough()
const zTypedDeleteQuery = z.object({
    type: z.literal('DELETE'),
    table: z.string(),
    where: zSQLQueryOrLiteralObj.optional(),
    returning: z.array(zReturningItem).optional(),
    params: z.record(z.string(), z.any()).optional(),
}).passthrough()
// Runtime: validates as discriminated union. Type: kept as Record<string, any> for DatabaseSettings compat.
// The TS types for sql-mode queries (SelectQuery, UpdateQuery, etc.) are defined separately in sql/build/.
// This schema catches invalid configs at parse time without needing to unify the Zod and TS type systems.
export const zTypedSQLQuery: z.ZodType<Record<string, any>> = z.discriminatedUnion('type', [
    zTypedSelectQuery,
    zTypedUpdateQuery,
    zTypedInsertQuery,
    zTypedDeleteQuery,
]) as any
export const zTypedSQLStatement = selectStatementSchema.or(insertStatementSchema).or(updateStatementSchema).or(deleteStatementSchema)

const zActionParamType = z.enum(['string', 'number', 'boolean', 'integer'])
const zSQLActionParamFull = z.object({
    type: zActionParamType,
    optional: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    description: z.string().max(500).optional(),
})
const zSQLActionParam = zActionParamType.or(zSQLActionParamFull)

export const zSQLAction = z.object({
    name: tableColumnNameSchema,
    description: z.string().max(1000).optional(),
    guard: sqlExprSchema.optional(),
    applyTableRules: z.boolean().default(true),
    requireAuth: z.boolean().optional().default(false),
    params: z.record(tableColumnNameSchema, zSQLActionParam).optional(),
    sql: z.union([zTypedSQLQuery, z.array(zTypedSQLQuery)]).optional(),
    steps: z.union([zTypedSQLStatement, z.array(zTypedSQLStatement)]).optional(),
}).superRefine((data, ctx) => {
    if (data.sql && data.steps) ctx.addIssue({code: 'custom', message: 'Cannot specify both sql and steps in the same action', path: ['steps']})
})

// not final, cant pass in query param
// export const joinObjSchema = z.object({
//     table: z.string(),
//     on: sqlExprSchema,
//     type: z.string().optional(),
// })
// export const joinObjSchema2 = z.array(joinObjSchema).or(joinObjSchema)

