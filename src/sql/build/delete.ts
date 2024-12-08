import {buildSelectWhere, joinReturning, SelectQuery, SelectQuerySelect1, SelectWhere} from './select'
import {SQLQuery} from '../../types/sql'

// data in this is expected to be safe already.
export type DeleteQuery = {
    type?: 'DELETE'
    table: string
    where?: SelectWhere
    returning?: (string|SelectQuerySelect1)[] // todo subqueries

    // params
    params?: Record<string, any>
}

// https://www.sqlite.org/lang_update.html
export function buildDeleteQuery(query: DeleteQuery, simplify = true, allowAllWhere = true): SQLQuery {
    const p = { ...query.params }
    let q = `DELETE FROM ${query.table} `

    if (query.where) {
        const where = buildSelectWhere(query.where, simplify)

        if(where === null || (!where.q && !allowAllWhere)) // null or true(literal) or empty string
            return {q: ''} // empty list? todo. or throw an error if allowAllWhere is false?

        q += ' WHERE ' + where.q
        Object.assign(p, where.p)
    } else if (!allowAllWhere){
        return {q: ''} // todo throw an error?
    } else {
        q += ' WHERE 1' // required because of sqlite optimisation so that it visits all rows?
    }

    if (query.returning?.length) {
        q += ' RETURNING ' + joinReturning(query.returning, p)
    }

    q += ';\n'
    return { q, p }
}
