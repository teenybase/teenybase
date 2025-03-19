import {z} from 'zod'
import {QueryType, QueryTypes} from '../sql/build/query'

export const sqlExprSchema = z.string().max(1000).regex(/^[a-zA-Z0-9_=\s():.*~%'"><!+\-&|@,\/\\${}]*$/, 'Invalid expression')
export const sqlExprSchemaRecord = z.record(sqlExprSchema)

export const sqlValSchema = z.string().or(z.number()).or(z.boolean()).or(z.null())
export const sqlValSchemaFile = z.boolean().or(z.string().or(z.number()).or(z.null()).or(z.instanceof(File)))
export const sqlValSchemaRecord = z.record(sqlValSchema)
export const sqlValSchema2 = sqlValSchema.or(sqlValSchemaRecord)
export const sqlValSchemaFile2 = z.record(sqlValSchemaFile)
export const sqlValSchemaFile3 = sqlValSchemaFile2.or(z.array(sqlValSchemaFile2))

export const sqlColListSchema = z.string().regex(/^[a-zA-Z0-9_,\s]*$/).or(z.literal('*'))
export const sqlColListSchemaOrder = z.string().regex(/^[a-zA-Z0-9_,\s+-]*$/)

// for search query params
export const sqlColListSchema2 = z.array(sqlColListSchema).or(sqlColListSchema)
export const sqlColListSchemaOrder2 = z.array(sqlColListSchemaOrder).or(sqlColListSchemaOrder)

// not final, cant pass in query param
// export const joinObjSchema = z.object({
//     table: z.string(),
//     on: sqlExprSchema,
//     type: z.string().optional(),
// })
// export const joinObjSchema2 = z.array(joinObjSchema).or(joinObjSchema)

export const tableColumnNameSchema = z.string()
    .min(1).max(255)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Table/Column name must start with a letter or underscore and can only contain letters, numbers and underscores')
//.or(z.literal('*')) // todo *

export interface SQLQuery{
    q: string,
    p?: Record<string, z.infer<typeof sqlValSchema2>>

    dependencies?: { // todo other types
        type: 'fts',
        table: string
        column?: string
    }[]
    _readOnly?: boolean
}

export function sqlRaw(q: string, p?: Record<string, z.infer<typeof sqlValSchema2>>): SQLQuery{
    return {q, p}
}
export function sqlValue<T extends z.infer<typeof sqlValSchema2>>(v: T): SQLLiteral<T>{
    return {l: v}
}
export const sql = (strings: TemplateStringsArray, ...values: any[]) => ({
    q: String.raw(strings, ...values)
})

export const zSQLQuery = z.object({
    q: z.string(),
    p: z.record(sqlValSchema2).optional()
})

export interface SQLLiteral<T=z.infer<typeof sqlValSchema2>> {
    l: T
    key?: string

    // for ts issues
    q?: undefined
    _readOnly?: undefined|true
}

export const zSQLLiteral = z.object({
    l: sqlValSchema2,
    key: z.string().optional()
})

export const zSQLQueryOrLiteral = zSQLQuery.or(zSQLLiteral)

export type OnConflict = 'ABORT' | 'FAIL' | 'IGNORE' | 'REPLACE' | 'ROLLBACK'
export const zOnConflict = z.enum(['ABORT', 'FAIL', 'IGNORE', 'REPLACE', 'ROLLBACK'])

export const selectSchema = z.object({
    where: sqlExprSchema.optional(),
    limit: z.coerce.number().optional(),
    offset: z.coerce.number().optional(),
    order: sqlColListSchemaOrder2.optional(),
    group: sqlColListSchema2.optional(),
    select: sqlExprSchema.or(z.array(sqlExprSchema)).optional(), // todo rename to fields in api v2
    distinct: z.coerce.boolean().optional(),

    // join: joinObjSchema2.array().optional(),
    // having: z.string().regex(/^[a-zA-Z0-9_=\s\(\)\.\*]*$/).optional(),
    // selectOption: z.string().optional(),
})

export type SelectParams = z.infer<typeof selectSchema>

export const updateSchema = z.object({
    or: zOnConflict.optional(),
    set: z.record(sqlExprSchema).optional(),
    setValues: z.record(sqlValSchema).optional(),
    where: sqlExprSchema,
    returning: z.array(sqlExprSchema).or(sqlExprSchema).optional()
})

export type UpdateParams = z.infer<typeof updateSchema>

export const insertSchema = z.object({
    or: zOnConflict.optional(),
    values: sqlValSchemaRecord.or(z.array(sqlValSchemaRecord)).optional(),
    expr: sqlExprSchemaRecord.or(z.array(sqlExprSchemaRecord)).optional(),
    returning: z.array(sqlExprSchema).or(sqlExprSchema).optional(),
})
export type InsertParams = z.infer<typeof insertSchema>

export const deleteSchema = z.object({
    where: sqlExprSchema,
    returning: z.array(sqlExprSchema).or(sqlExprSchema).optional(),
})

export type DeleteParams = z.infer<typeof deleteSchema>

export const tableDeleteSchema = deleteSchema
export type TableDeleteParams = DeleteParams
export const tableInsertSchema = insertSchema.omit({values: true}).extend({values: sqlValSchemaFile3})
export type TableInsertParams = z.infer<typeof tableInsertSchema>
export const tableUpdateSchema = updateSchema.omit({setValues: true}).extend({setValues: sqlValSchemaFile2.optional()})
export type TableUpdateParams = z.infer<typeof tableUpdateSchema>
export const tableSelectSchema = selectSchema
export type TableSelectParams = SelectParams
export const tableViewSchema = selectSchema.pick({select: true, where: true})
export type TableViewParams = z.infer<typeof tableViewSchema>
export const tableEditSchema = z.object({setValues: sqlValSchemaFile2, or: updateSchema.shape.or.or(z.literal('INSERT')), returning: updateSchema.shape.returning})
export type TableEditParams = z.infer<typeof tableEditSchema>

export const selectStatementSchema = tableSelectSchema.extend({
    type: z.literal('SELECT'),
    table: tableColumnNameSchema,
})
export type SelectStatement = z.infer<typeof selectStatementSchema>
export const insertStatementSchema = tableInsertSchema.extend({
    type: z.literal('INSERT'),
    table: tableColumnNameSchema,
})
export type InsertStatement = z.infer<typeof insertStatementSchema>
export const updateStatementSchema = tableUpdateSchema.extend({
    type: z.literal('UPDATE'),
    table: tableColumnNameSchema,
})
export type UpdateStatement = z.infer<typeof updateStatementSchema>
export const deleteStatementSchema = tableDeleteSchema.extend({
    type: z.literal('DELETE'),
    table: tableColumnNameSchema,
})
export type DeleteStatement = z.infer<typeof deleteStatementSchema>

export interface StatementTypes{
    select: SelectStatement
    insert: InsertStatement
    update: UpdateStatement
    delete: DeleteStatement
}

export interface SQLIndex {
    name?: string
    unique?: boolean
    fields: string | string[]
    where?: SQLQuery /*| string*/ // todo support strings with jsep
}

export const zSQLIndex = z.object({
    name: tableColumnNameSchema.optional(),
    unique: z.coerce.boolean().optional(),
    // fields: tableColumnNameSchema.or(z.array(tableColumnNameSchema)),
    fields: z.string().or(z.array(z.string())),// fields can include collate also
    where: zSQLQuery.optional(),
})

export interface SQLTrigger {
    // temp?: boolean
    name: string
    event: 'INSERT' | 'DELETE' | 'UPDATE'/* | 'SELECT'*/ | string
    /**
     * Default is BEFORE in sqlite
     */
    seq?: 'BEFORE' | 'AFTER' | 'INSTEAD OF' | string
    /**
     * Only for UPDATE event
     */
    updateOf?: string[] | string
    /**
     * Optional. STATEMENT is not supported in sqlite
     */
    forEach?: 'ROW'/* | 'STATEMENT'*/
    /**
     * Trigger body
     *
     * Notes -
     * INSERT	NEW references are valid
     * UPDATE	NEW and OLD references are valid
     * DELETE	OLD references are valid
     *
     * An ON CONFLICT clause may be specified as part of an UPDATE or INSERT event within the body of the trigger. However if an ON CONFLICT clause is specified as part of the statement causing the trigger to fire, then conflict handling policy of the outer statement is used instead.
     */
    // todo support strings with jsep.
    //  also support SelectQuery, DeleteQuery etc apart from SQLQuery
    body: SQLQuery[] | SQLQuery /*| string*/
    /**
     * SQL statements specified are only executed if the WHEN clause is true.
     *
     * Notes -
     * INSERT	NEW references are valid
     * UPDATE	NEW and OLD references are valid
     * DELETE	OLD references are valid
     */
    when?: SQLQuery /*| string*/ // todo support strings with jsep
}

export const zSQLTrigger = z.object({
    name: tableColumnNameSchema,
    event: z.enum(['INSERT', 'DELETE', 'UPDATE']),
    seq: z.enum(['BEFORE', 'AFTER', 'INSTEAD OF']).optional(),
    updateOf: tableColumnNameSchema.or(z.array(tableColumnNameSchema)).optional(),
    forEach: z.enum(['ROW']).optional(),
    body: zSQLQuery.or(z.array(zSQLQuery)),
    when: zSQLQuery.optional(),
})

export interface SQLProcedure{
    name: string,
    /**
     * If true, run with default rules based on the statements
     * If false, run as admin
     * If string, use string as the rule for all statements. todo
     * @default true
     */
    rule?: boolean /*| string*/
    params?: string[]
    query?: QueryTypes[QueryType]|((QueryTypes[QueryType])[])
    statement?: StatementTypes[QueryType]|((StatementTypes[QueryType])[])
}

export const zTypedSQLQuery = z.record(z.string(), z.any()) // todo SelectQuery|UpdateQuery...
export const zTypedSQLStatement = selectStatementSchema.or(insertStatementSchema).or(updateStatementSchema).or(deleteStatementSchema)
export const zSQLProcedure = z.object({
    name: tableColumnNameSchema,
    rule: z.boolean()/*.or(z.string())*/.default(true),
    params: z.array(tableColumnNameSchema),
    query: z.union([zTypedSQLQuery, z.array(zTypedSQLQuery)]).optional(),
    statement: z.union([zTypedSQLStatement, z.array(zTypedSQLStatement)]).optional(),
})
