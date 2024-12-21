import {UPDATE_NEW_COL_ID} from './update'
import {columnify} from '../parse/jsep'
import {buildSelectWhere, joinReturning, SelectQuery, SelectQuerySelect1, SelectWhere} from './select'
import {OnConflict, SQLLiteral, SQLQuery} from '../../types/sql'
import {literalToQuery} from './query'

// data in this is expected to be safe already.
export type InsertQuery = {
    type?: 'INSERT'
    table: string
    values: Record<string, SQLQuery|SQLLiteral> | (Record<string, SQLQuery|SQLLiteral>[])
    returning?: (string|SelectQuerySelect1)[] // todo subqueries
    where?: SelectWhere
    or?: OnConflict

    // params
    params?: Record<string, any>
}

// https://www.sqlite.org/lang_insert.html
export function buildInsertQuery(query: InsertQuery, simplify = true, allowAllWhere = true): SQLQuery {
    const p = { ...query.params }
    let q = 'INSERT'

    if(query.or) q += ` OR ${query.or}`

    q += ` INTO ${query.table}`

    const values = Array.isArray(query.values) ? query.values : [query.values]
    if(!values.length) throw new Error('No values provided')
    const keys = Object.keys(values[0])

    const valueSql = []
    for (let j = 0; j < values.length; j++){
        const value = values[j]
        const vals = []
        const setKeys = Object.keys(value)
        if(setKeys.length !== keys.length) throw new Error('All values must have the same keys')
        for (let i = 0; i < keys.length; i++){
            const key = keys[i]
            if(setKeys[i] !== key) throw new Error('All values must have the same keys')
            const set = literalToQuery(value[key])
            vals.push(set.q)
            Object.assign(p, set.p)
        }
        valueSql.push(`${vals.join(', ')}`)
    }

    const keysSql = keys.map(k => columnify(k)).join(', ')

    const where = query.where ? buildSelectWhere(query.where, simplify) : undefined

    if(where === null) // null or true(literal) or empty string
        return {q: ''} // empty list? todo. or throw an error?

    if(!where || (!where.q && !allowAllWhere)) {
        q += ` (${keysSql}) VALUES (${valueSql.join('), (')})`
    }else {
        // WITH new (column1, column2, ...) AS (
        //   SELECT value1, value2, ..., UNION ALL
        //   SELECT value1, value2, ...,
        // )
        // INSERT INTO my_table (column1, column2, ...)
        // SELECT column1, column2, ...
        // FROM new
        // WHERE column1 NOT LIKE 'hello2%'
        //   AND new.column2 NOT LIKE 'hello2%' // new.column2 is equivalent to column2
        //   AND (other validation conditions);
        const selectVals = valueSql.map(v => `SELECT ${v}`).join(' UNION ALL ')
        // const cteName = 'new_record_cte'
        const cteName = UPDATE_NEW_COL_ID
        q = `WITH ${cteName} (${keysSql}) AS (${selectVals}) ${q} (${keysSql}) `
        q += `SELECT ${keysSql} FROM ${cteName} WHERE ${where.q || '1'}`
        Object.assign(p, where.p)
    }

    if (query.returning?.length) {
        q += ' RETURNING ' + joinReturning(query.returning, p)
    }

    q += ';\n'
    return { q, p }
}


// INSERT INTO my_table (column1, column2, ...)
// SELECT value1, value2, ...
// WHERE value1 NOT LIKE 'custom_expression'
//   AND (other validation conditions);

// or
// using cte so that we dont have to replace the values column names to values in the select query where clause

// WITH my_values (column1, column2, ...) AS (
//   SELECT value1, value2, ...,
// )
// INSERT INTO my_table (column1, column2, ...)
// SELECT column1, column2, ...
// FROM my_values
// WHERE column1 NOT LIKE 'hello2%'
//   AND (other validation conditions);
