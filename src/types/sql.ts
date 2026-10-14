import {z} from 'zod'
import {QueryType, QueryTypes} from '../sql/build/query'
import {
    deleteSchema,
    deleteStatementSchema,
    insertSchema,
    insertStatementSchema,
    selectSchema,
    selectStatementSchema,
    sqlValSchema2,
    tableEditSchema,
    tableInsertSchema,
    tableUpdateSchema,
    tableViewSchema,
    updateSchema,
    updateStatementSchema
} from './zod/sqlSchemas'

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

export interface SQLLiteral<T=z.infer<typeof sqlValSchema2>> {
    l: T
    key?: string
    /**
     * Mark this value as secret. It is still bound as a normal SQL parameter and reaches SQLite
     * unchanged - it is only never rendered by logSQLQuery(), so it cannot reach D1Error.input,
     * the query log, or an error response.
     */
    redact?: true

    // for ts issues
    q?: undefined
    _readOnly?: undefined|true
}

export type OnConflict = 'ABORT' | 'FAIL' | 'IGNORE' | 'REPLACE' | 'ROLLBACK'

export type SelectParams = z.infer<typeof selectSchema>

export type UpdateParams = z.infer<typeof updateSchema>

export type InsertParams = z.infer<typeof insertSchema>

export type DeleteParams = z.infer<typeof deleteSchema>

export type TableDeleteParams = DeleteParams
export type TableInsertParams = z.infer<typeof tableInsertSchema>
export type TableUpdateParams = z.infer<typeof tableUpdateSchema>
export type TableSelectParams = SelectParams
export type TableViewParams = z.infer<typeof tableViewSchema>
export type TableEditParams = z.infer<typeof tableEditSchema>

export type SelectStatement = z.infer<typeof selectStatementSchema>
export type InsertStatement = z.infer<typeof insertStatementSchema>
export type UpdateStatement = z.infer<typeof updateStatementSchema>
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

export type ActionParamType = 'string' | 'number' | 'boolean' | 'integer'

export interface SQLActionParam {
    type: ActionParamType
    /** If true, parameter is optional. @default false */
    optional?: boolean
    /** Default value when optional param is not provided */
    default?: string | number | boolean | null
    /** Description for OpenAPI docs */
    description?: string
}

export interface SQLAction {
    name: string
    /** Description for OpenAPI docs */
    description?: string
    /**
     * Expression evaluated ONCE before steps/sql execute as an invocation guard.
     * Can reference auth.*, params.*, request.*, and SQLite functions.
     * Cannot reference table columns.
     * Evaluated in JS when possible (instant), falls back to SQL query for SQLite functions.
     * @example "auth.role == 'admin'"
     * @example "auth.uid != null & params.secret == 'magic'"
     */
    guard?: string
    /**
     * Whether table-level RLS rules (listRule, createRule, updateRule, deleteRule) apply per step.
     * Only relevant for steps mode (sql mode always bypasses table rules).
     * @default true
     */
    applyTableRules?: boolean
    /**
     * If true, request must include a valid auth token.
     * @default false
     */
    requireAuth?: boolean
    /**
     * Named parameters with type validation.
     * Key is the param name, value is the type config or shorthand type string.
     */
    params?: Record<string, SQLActionParam | ActionParamType>
    /**
     * Raw SQL query objects using sql tagged templates.
     * Cannot be combined with `steps`.
     * Table rules are not applied (sql mode bypasses $Table extension hooks).
     */
    sql?: QueryTypes[QueryType]|((QueryTypes[QueryType])[])
    /**
     * Expression-based statements parsed at runtime via jsep.
     * Rules CAN be applied. Cannot be combined with `sql`.
     */
    steps?: StatementTypes[QueryType]|((StatementTypes[QueryType])[])
}

