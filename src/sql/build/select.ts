import {literalToQuery, SQLLiteral, SQLQuery} from './query'
import {applyBoolJoinOperator} from '../parse/jsep'

export type SelectWhere = (SQLQuery|SQLLiteral) | ((SQLQuery|SQLLiteral)[]) // if array, all expressions are joined by AND
export function appendWhere(query: {where?: SelectWhere}, sql: SQLQuery|SQLLiteral) {
    if(Array.isArray(query.where)) query.where.push(sql)
    else query.where = query.where ? [query.where, sql] : sql
    return query
}
// data in this is expected to be safe already.
export type SelectQuery = {
    selects?: string | (string)[]
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

    // query: string // 'select a,b,c from tableName'

    // join?: {
    //     table: string
    //     on: SQLQuery
    //     // using?: (string|[string, string])[]
    //     type?: string
    // }[]
    // union: UnionInfo[]
    // params: Params
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
    return literalToQuery(q)
}

// https://www.sqlite.org/lang_select.html
export function buildSelectQuery(query: SelectQuery, simplify = true, allowAllWhere = true): SQLQuery { // todo make property for allowAllWhere in table settings
    const p = {...query.params}
    let q = 'SELECT '
    if(query.distinct)
        q += 'DISTINCT '
    if(query.selectOption)
        q += query.selectOption + ' '
    if(query.selects?.length)
        q += typeof query.selects === 'string' ? query.selects : query.selects.join(', ')
    else if(query.from)
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
    // if (query.join?.length) {
    //     for (const j of query.join) {
    //         q += ` ${j.type} JOIN ${j.table} ON ${j.on.q}`
    //         Object.assign(p, j.on.p)
    //     }
    // }
    if (query.where) {
        // todo do the same for having, update and delete query
        // todo write tests for this where simplification
        let where = buildSelectWhere(query.where, simplify)
        // console.log('where', where, query)

        if(where === null || (!where.q && !allowAllWhere)) // null or true(literal) or empty string
            return {q: ''} // empty list? todo. or throw an error if allowAllWhere is false?

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
    q += ';\n'
    return { q, p };
}
