import {z} from 'zod'

export const sqlExprSchema = z.string().max(1000).regex(/^[a-zA-Z0-9_=\s():.*~%'"><!+\-&|@,\/\\${}]*$/)
export const sqlExprSchemaRecord = z.record(sqlExprSchema)

export const sqlValSchema = z.string().or(z.number()).or(z.boolean()).or(z.null())
export const sqlValSchemaFile = z.coerce.boolean().or(z.string().or(z.number()).or(z.null()).or(z.instanceof(File)))
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
}

export const zSQLLiteral = z.object({
    l: sqlValSchema2,
    key: z.string().optional()
})

export const zSQLQueryOrLiteral = zSQLQuery.or(zSQLLiteral)

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
    updateOf: z.array(tableColumnNameSchema).optional(),
    forEach: z.enum(['ROW']).optional(),
    body: zSQLQuery.or(z.array(zSQLQuery)),
    when: zSQLQuery.optional(),
})
