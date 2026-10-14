import {HTTPException} from 'hono/http-exception'
import {$Table} from '../$Table'
import {ProcessError} from '../util/error'
import {TableExtension} from '../tableExtension'
import {TableRulesExtensionData} from '../../types/tableExtensions'
import {JsepContext} from '../../sql/parse/jsep'
import {appendWhere, getSubSelectQueries, SelectQuery, SelectWhere} from '../../sql/build/select'
import {InsertQuery} from '../../sql/build/insert'
import {UPDATE_NEW_COL_ID, UpdateQuery} from '../../sql/build/update'
import {DeleteQuery} from '../../sql/build/delete'
import {queryToSqlQuery} from '../../sql/parse/parse'
import {sqlExprSchema} from '../../types/zod/sqlSchemas';
import {tableRulesDataSchema} from '../../types/zod/tableExtensionsSchema'

export class TableRulesExtension extends TableExtension<TableRulesExtensionData>{
    static readonly name = 'rules'
    constructor(data: TableRulesExtensionData, table: $Table, jc: JsepContext){
        super(tableRulesDataSchema.parse(data), table, jc)
        if(data.name !== TableRulesExtension.name) throw new HTTPException(500, {message: 'Invalid Configuration'})
    }

    private _applyWhere(jc: JsepContext, query: {where?: SelectWhere}, rule: string | null) {
        if(jc.globals.auth?.admin) return // todo add flag?
        // console.log('rule', rule)
        const ruleSql = parseRuleQuery(jc, rule)
        // const simplify = jc.c.req.header('$DB_TEST_PARSE_SIMPLIFY_DISABLE') !== 'true'

        // query.where = query.where ? applyBinaryOperator(query.where, ruleSql, 'AND', simplify) : ruleSql
        appendWhere(query, ruleSql)
    }

    /**
     * `OR REPLACE` resolves a primary-key or unique conflict by deleting the existing row(s), and SQLite does
     * that without any WHERE clause, so deleteRule (and updateRule) are never checked against those rows.
     * Non-admin callers may only use it when deleteRule lets them delete any row anyway, and the table has
     * no trigger on that event: SQLite applies the outer statement's conflict policy to the statements in a
     * trigger body too, so the trigger's writes to other tables would also run as OR REPLACE.
     * Also covers `/edit/:id?or=INSERT`, which is implemented as INSERT OR REPLACE.
     * (TableAuthExtension rejects non-admin REPLACE on auth tables on its own, as it vetoes all non-admin deletes.)
     */
    private _checkConflictClause(query: {or?: string}, event: 'INSERT' | 'UPDATE') {
        if(this.jc.globals.auth?.admin) return
        if(query.or?.trim().toUpperCase() !== 'REPLACE') return
        const deleteRule = this.data.deleteRule
        const hasTrigger = (this.table.data.triggers ?? []).some(t => t.event?.toUpperCase() === event)
        if((deleteRule === 'true' || deleteRule === '1') && !hasTrigger) return
        throw new ProcessError(`OR REPLACE (also used by edit with or=INSERT) is not allowed on table "${this.table.name}": it deletes conflicting rows without checking deleteRule. Insert or update the record instead`, 403)
    }

    async onInsertParse(query: InsertQuery){
        this._checkConflictClause(query, 'INSERT')
        // todo add allowed columns based on what data is passed in the insert
        //  so if the rule is `role = 'guest'` and role is not in the insert data, throw an error

        // const values = Array.isArray(query.values) ? query.values[0] : query.values
        this._applyWhere({
            ...this.jc,
            tableName: UPDATE_NEW_COL_ID,
            allowedTables: {[UPDATE_NEW_COL_ID]: this.jc.allowedTables[this.jc.tableName]},
            // todo check later, might have issues
            // Pass insert values as known literals so the expression parser can resolve
            // new.* references (same pattern as parseUpdateQuery for update rules).
            // This enables simplification: e.g., role == 'guest' with role='guest' → true.
            // extras: { ...this.jc.extras,
            //     [UPDATE_NEW_COL_ID]: {
            //         table: this.jc.tableName,
            //         literals: values || {},
            //     }
            // },
        }, query, this.data.createRule)
    }

    async onDeleteParse(query: DeleteQuery){
        this._applyWhere(this.jc, query, this.data.deleteRule)
    }
    async onSelectParse(query: SelectQuery){
        this._applyWhere(this.jc, query, this.data.listRule)
    }
    async onViewParse(query: SelectQuery){
        this._applyWhere(this.jc, query, this.data.viewRule)
    }
    async onUpdateParse(query: UpdateQuery){
        this._checkConflictClause(query, 'UPDATE')
        this._applyWhere(query.contextWithNew || this.jc, query, this.data.updateRule)
    }
}

export function parseRuleQuery(c: JsepContext, rule?: string | null){
    if(rule === null || rule === undefined){
        // todo check only admin
        throw new ProcessError('Forbidden', 403)
    }
    if(rule === 'true' || rule === '1') return {q: "1"}
    if(typeof rule !== 'string') throw new ProcessError('Invalid Configuration', 500)
    if(!rule.trim().length) throw new ProcessError('Not Found', 404)
    rule = sqlExprSchema.parse(rule)
    try {
        return queryToSqlQuery(rule, c)
    }catch (e){
        throw new ProcessError('Error parsing rule', 500, {input: rule}, e)
    }
}

