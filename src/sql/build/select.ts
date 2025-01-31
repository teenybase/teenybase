import {applyBoolJoinOperator, uncolumnify} from '../parse/jsep'
import {SQLLiteral, SQLQuery} from '../../types/sql'
import {literalToQuery} from './query'

export type SelectWhere = (SQLQuery|SQLLiteral) | ((SQLQuery|SQLLiteral)[]) // if array, all expressions are joined by AND

// data in this is expected to be safe already.
export type SelectQuerySelect1 = SQLQuery & {as: string}
export type SelectQuerySelect = (string|(SelectSubQuery&{q?: undefined})|SelectQuerySelect1)
export type SelectQuery = {
    type?: 'SELECT'
    selects?: (string | SelectQuerySelect)[]
    distinct?: boolean
    selectOption?: string
    where?: SelectWhere
    orderBy?: string | string[]
    groupBy?: string[]
    having?: SQLQuery|SQLLiteral
    limit?: number
    offset?: number
    from?: string[]|string

    // params
    params?: Record<string, any>

    // for subqueries (SELECT ...) AS abc
    // as?: string

    // query: string // 'select a,b,c from tableName'

    join?: SelectQueryJoin[]
    // union: UnionInfo[]
    // params: Params

    _readOnly?: boolean
}
export interface SelectQueryJoin{
    type?: string // NATURAL, LEFT, INNER, CROSS, etc
    table: string /*| SelectSubQuery*/
    on: SQLQuery|SQLLiteral
    // using: string[]
}
export type SelectSubQuery = SelectQuery & {
    // for subqueries (SELECT ...) AS abc
    as: string
}

export function getSubSelectQueries(query: SelectQuery){
    const subQueries = Array.isArray(query.selects) ? query.selects
        // todo better check
        .filter(s=>typeof s !== 'string' && (s as SelectSubQuery).from !== undefined && (s as SelectSubQuery).as !== undefined) : []
    return subQueries as SelectSubQuery[]
}

export function buildSelectWhere(queryWhere: SelectWhere, simplify: boolean) {
    let q: SQLQuery|SQLLiteral
    if (Array.isArray(queryWhere)) {
        q = applyBoolJoinOperator(queryWhere, 'AND', simplify)
    } else if (simplify && (queryWhere as SQLLiteral).l !== undefined) {
        const l = (queryWhere as SQLLiteral).l
        if (!l || l === '' || l === 'false' || l === '0' || l === 'null') {
            return null
        }
        if (l === true || typeof l === 'number' || l === 'true' || l === '1') {
            return {q: ''}
        }
        throw new Error(`Invalid where clause literal ${l}`)
    } else {
        q = queryWhere
    }

    // this fn call also adds brackets around where, so don't remove even though we know it's not a literal.
    return literalToQuery(q, true)
}

// todo subquery and merge with selects
export function joinReturning(returning: (string|SelectQuerySelect1)[], p: Record<string, any>): string {
    return returning.map(select=>{
        if(typeof select === 'string' || typeof select.q === 'string') {
            return typeof select === 'string' ? select : (select.q + ' AS ' + select.as)
        }else {
            // todo subquery
            throw new Error('Invalid returning')
        }}).join(', ')
}

// https://www.sqlite.org/lang_select.html
export function buildSelectQuery(query: SelectQuery|SelectSubQuery, simplify = true, allowAllWhere = true): SQLQuery { // todo make property for allowAllWhere in table settings
    const inSubquery = !!(query as SelectSubQuery).as

    const p = {...query.params}
    let q = 'SELECT '
    if(query.distinct)
        q += 'DISTINCT '
    if(query.selectOption)
        q += query.selectOption + ' '
    if(query.selects?.length){
        const selects = Array.isArray(query.selects) ? query.selects : [query.selects]

        // json_group_array(json_object('name', name, 'email', email))
        const subQueryJson = inSubquery && selects.length > 1
        // limit is set to 1 in subquery if the fk field is unique/primary key in the table.
        const subQueryJsonArray = subQueryJson && query.limit !== 1

        let selectQ = selects.map(select=>{
            const isStr = typeof select === 'string'
            if(isStr || typeof select.q === 'string') {
                if(!isStr && select.p) Object.assign(p, select.p)
                if(subQueryJson){
                    const name = isStr ? select : select.as
                    if(!name) throw new Error('Expand/Subquery selects must have an AS property')
                    const q = isStr ? select : select.q
                    // [users].[email] -> email
                    const printableName = uncolumnify(name.split('.').pop()!)
                    const lit = literalToQuery({l: printableName})
                    Object.assign(p, lit.p)
                    return lit.q + ','  + q
                }
                return isStr ? select : (select.q + (select.as ? (' AS ' + select.as) : ''))
            }
            else{
                const col = select as SelectQuery
                if(!col.from) throw new Error('Subquery must have a FROM property')
                // subquery
                const subQuery = buildSelectQuery(select, simplify, allowAllWhere)
                Object.assign(p, subQuery.p)
                let asName = select.as || select.from
                if(typeof asName !== 'string') throw new Error('Subquery must have an AS or a single FROM property')
                return `(${subQuery.q}) AS ${asName}`
            }
        }).join(', ')

        // todo we know the output is json, so we also need to JSON.parse it
        if(subQueryJson) selectQ = `json_object(${selectQ})`
        if(subQueryJsonArray) selectQ = `json_group_array(${selectQ})` // should not be elseif because it can be both

        q += selectQ
    }else if(query.from)
        q += typeof query.from === 'string' ? query.from + '.*' : query.from.map(f => f + '.*').join(', ')
    else {
        if(query.distinct || query.selectOption){
            throw new Error('selects must be provided if distinct or selectOption is set')
        }
        q = ''
    } // we will just return the query without select

    // if (prefix) q = prefix + ' ' + q // doing this here because clearing the q above.

    if (query.from) {
        q += ' FROM ' + (typeof query.from === 'string' ? query.from : query.from.join(', '));
    }
    if (query.join?.length) {
        for (const j of query.join) {
            const onClause = literalToQuery(j.on)
            const type = j.type ? j.type.toUpperCase() + ' ' : ''
            q += ` ${type}JOIN ${j.table} ON ${onClause.q}`
            Object.assign(p, onClause.p)
        }
    }
    if (query.where) {
        // todo do the same for having, update and delete query
        // todo write tests for this where simplification
        let where = buildSelectWhere(query.where, simplify)
        // console.log('where', where, query)

        if(where === null || (!where.q && !allowAllWhere)) // null or true(literal) or empty string
            return {q: ''} // empty list? todo. or throw an error if allowAllWhere is false?

        // todo this will be an issue in case we allow RAISE in select. this will not raise and continue the transaction
        q += ' WHERE ' + (where.q||'1'); // empty string means true if allowAllWhere is true. false otherwise
        if(where.p) Object.assign(p, where.p)
    } else if (!allowAllWhere){
        return {q: ''} // todo throw an error?
    } else {
        q += ' WHERE 1' // required because of sqlite optimisation so that it visits all rows?
    }

    if (query.groupBy?.length) {
        q += ' GROUP BY ' + query.groupBy.join(', ');
    }
    if (query.having) {
        const having = literalToQuery(query.having)
        q += ' HAVING ' + having.q;
        Object.assign(p, having.p)
    }
    if (query.orderBy?.length) {
        q += ' ORDER BY ' + ((typeof query.orderBy === 'string') ? query.orderBy : query.orderBy.join(', '));
    }
    if (query.limit !== undefined) {
        let limit = query.limit;
        if (limit < 0 && query.offset) {
            // most DBMS requires LIMIT when OFFSET is present
            limit = Number.MAX_SAFE_INTEGER; // 2^53 - 1
        }
        if (limit >= 0) q += ' LIMIT ' + limit;
    }
    if (query.offset !== undefined && query.offset > 0) {
        q += ' OFFSET ' + query.offset;
    }
    if(!inSubquery)
        q += ';\n'

    return { q, p, _readOnly: query._readOnly };
}

export function appendWhere(query: {where?: SelectWhere}, sql: SQLQuery|SQLLiteral) {
    if(Array.isArray(query.where)) query.where.push(sql)
    else query.where = query.where ? [query.where, sql] : sql
    return query
}
export function appendOrderBy(query: SelectQuery, sql: string) {
    if(Array.isArray(query.orderBy)) query.orderBy.push(sql)
    else query.orderBy = query.orderBy ? [query.orderBy, sql] : sql
    return query
}
export function appendJoin(query: SelectQuery, join: SelectQueryJoin) {
    if(!query.join) query.join = []
    query.join.push(join)
    return query
}
