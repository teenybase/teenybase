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

    async onInsertParse(query: InsertQuery){
        // todo add allowed columns based on what data is passed in the insert
        //  so if the rule is `role = 'guest'` and role is not in the insert data, throw an error
        this._applyWhere({
            ...this.jc,
            tableName: UPDATE_NEW_COL_ID,
            allowedTables: {[UPDATE_NEW_COL_ID]: this.jc.allowedTables[this.jc.tableName]},
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

