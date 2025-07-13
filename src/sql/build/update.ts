import {columnify, JsepContext} from '../parse/jsep'
import {buildSelectWhere, joinReturning, SelectQuerySelect1, SelectWhere} from './select'
import {OnConflict, SQLLiteral, SQLQuery} from '../../types/sql'
import {literalToQuery} from './query'

// data in this is expected to be safe already.
export type UpdateQuery = {
    type?: 'UPDATE'
    table: string
    set: Record<string, SQLQuery|SQLLiteral>
    where?: SelectWhere
    returning?: (string|SelectQuerySelect1)[] // todo subqueries
    contextWithNew?: JsepContext, // has extras object with new. data
    or?: OnConflict

    // params
    params?: Record<string, any>
}

export const UPDATE_NEW_COL_ID = columnify('new')

// https://www.sqlite.org/lang_update.html
export function buildUpdateQuery(query: UpdateQuery, simplify = true, allowAllWhere = true/*, oldFields?: {q: string, as: string}[]*/): SQLQuery {
    const p = { ...query.params }
    let q = `UPDATE ${query.table} `

    if(query.or) q += `OR ${query.or} `

    q += 'SET '

    let where = ''
    if(query.where){
        const whereQ = buildSelectWhere(query.where, simplify)

        if(whereQ === null || (!whereQ.q && !allowAllWhere)) // null or true(literal) or empty string
            return {q: ''} // empty list? todo. or throw an error if allowAllWhere is false?

        where = whereQ.q
        Object.assign(p, whereQ.p)
    } else if (!allowAllWhere){
        return {q: ''} // todo throw an error?
    } else {
        // q += ' WHERE 1' // required because of sqlite optimisation so that it visits all rows? so shouldn't be needed here
    }

    const setKeys = Object.keys(query.set)
    for (let i = 0; i < setKeys.length; i++) {
        const key = setKeys[i]
        const set = literalToQuery(query.set[key])
        if(i > 0) q += ', '

        q += `${columnify(key)} = ${set.q}`
        Object.assign(p, set.p)

    }

    const returning = query.returning || []

    // if(oldFields?.length) {
    //     const rnd = Math.random().toString(36).substring(2, 7)
    //     const key = '_ov_' + rnd
    //     const cte = `WITH ${key} AS (SELECT rowid, ${joinReturning(oldFields.map((f, i)=>({q:f.q, as: columnify(`c_${rnd}_${i}`)})), p)} FROM ${query.table} WHERE ${where}) `
    //     q = cte + q
    //     q += ' WHERE rowid IN (SELECT rowid FROM ' + key + ')'
    //     returning.push(...oldFields.map((f, i) => ({ q: key + '.' + columnify(`c_${rnd}_${i}`), as: f.as})))
    // }else
    if (where) {
        q += ' WHERE ' + where
    }

    if (returning.length) {
        q += ' RETURNING ' + joinReturning(returning, p)
    }

    q += ';\n'
    return { q, p }
}

// WITH new_value (column1, column2, ...) AS (
//   SELECT value1, value2, ...,
// )
// UPDATE my_table
// SET column1 = value1, column2 = value2, ...
// FROM new_value
// WHERE new_value.column1 LIKE 'hello%' and column1 = new_value.column1
// all ai say this^ wont work

//or this is better anyway
// UPDATE my_table
// SET column1 = new_value.column1, column2 = new_value.column2, ...
// FROM (
//   SELECT value1 AS column1, value2 AS column2, ...
// ) AS new_value
// WHERE column1 = new_value.column1
// doest work when updating multiple records and referencing columns

// final option
// UPDATE my_table
// SET column1 = value1, column2 = value1, ...
// WHERE column1 = [new].[column1]
// replace [new].[column1] with value1 using string replace

// another option is to make a temp trigger or another statement that checks first

//WITH _ov_1bskx AS (
// SELECT rowid, [files].[file] AS [c_1bskx_0] FROM [files] WHERE
// )
// UPDATE [files] SET [file] = {:ffchyf}, [updated] = (CURRENT_TIMESTAMP) WHERE rowid IN (SELECT rowid FROM _ov_1bskx) RETURNING [files].[path], [files].[name], [files].[id], [files].[file], [files].[file] AS _1f_277mc8vcd21, _ov_1bskx.[c_1bskx_0] AS _0f_oy7hbxmj7ca;
