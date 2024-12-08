import {columnify, JsepContext} from '../parse/jsep'
import {buildSelectWhere, joinReturning, SelectQuerySelect1, SelectWhere} from './select'
import {SQLLiteral, SQLQuery} from '../../types/sql'
import {literalToQuery} from './query'

// data in this is expected to be safe already.
export type UpdateQuery = {
    table: string
    set: Record<string, SQLQuery|SQLLiteral>
    where?: SelectWhere
    returning?: (string|SelectQuerySelect1)[] // todo subqueries
    contextWithNew?: JsepContext, // has extras object with new. data

    // params
    params?: Record<string, any>
}

export const UPDATE_NEW_COL_ID = columnify('new')

// https://www.sqlite.org/lang_update.html
export function buildUpdateQuery(query: UpdateQuery, simplify = true, allowAllWhere = true): SQLQuery {
    const p = { ...query.params }
    let q = `UPDATE ${query.table} SET `

    // const hasNew = true
    // const hasNew = query.where?.q.includes(newCol+'.')
    // let newRow = ''

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
        // if(!hasNew)
            q += `${columnify(key)} = ${set.q}`
        // else{
        //     q += `${key} = ${newCol}.${key}`
        //     newRow += (i > 0 ? ', ' : '') + set.q + ' AS ' + key
        // }
        Object.assign(p, set.p)

        // todo - this is an issue we have to do a proper replace or this will replace this string also.
        //  like - if a ~ '[new].[col]'
        //  it will be replaced with a ~ 'value', which is wrong
        //  the replace has to be resolved in jsep
        // where = where.replaceAll(UPDATE_NEW_COL_ID+'.'+key, set.q)
    }

    // if(hasNew){
        // UPDATE my_table
        // SET column1 = value1, column2 = value1, ...
        // WHERE column1 = [new].[column1]
        // replace [new].[column1] with value1 using string replace

        // q += ' FROM ('
        // q += 'SELECT ' + newRow

        // q += ' FROM ' + query.table
        // if (query.where) q += ' WHERE ' + query.where.q

        // q += ') AS ' + newCol
    // }

    if (where) {
        q += ' WHERE ' + where
    }

    if (query.returning?.length) {
        q += ' RETURNING ' + joinReturning(query.returning, p)
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
