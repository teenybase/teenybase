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
    /**
     * Value of every column the row gets when the statement doesn't set it (the column default, or NULL).
     * Only used when there is a `where`: columns missing from `values` are added to the `[new]` CTE with
     * these values, so a createRule can read `new.<col>` / `<col>` for a column the request left out.
     * They are never part of the INSERT column list, so the table's own defaults still apply.
     * Set by TableRulesExtension.
     */
    columnDefaults?: Record<string, SQLQuery|SQLLiteral>

    // params
    params?: Record<string, any>
}

// https://www.sqlite.org/lang_insert.html
/**
 * @param redactColumns columns whose bound values must never be rendered by logSQLQuery - see
 *   $Table.redactedFields. The value is still bound normally; only its rendering is suppressed.
 */
export function buildInsertQuery(query: InsertQuery, simplify = true, allowAllWhere = true,
                                 redactColumns?: ReadonlySet<string>): SQLQuery {
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
        // $Table.checkSameKeys reports this to clients; key order may differ between rows
        const setKeys = Object.keys(value)
        if(setKeys.length !== keys.length || keys.some(k => !Object.prototype.hasOwnProperty.call(value, k)))
            throw new Error('All values must have the same keys')
        for (const key of keys){
            const set = literalToQuery(value[key], true, redactColumns?.has(key))
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
        // Columns the statement leaves out still exist in [new], with the value the row will get, so the
        // where (createRule) can reference them. Every row has the same keys, so this is the same set for all rows.
        const defaultKeys = Object.keys(query.columnDefaults ?? {}).filter(k => !keys.includes(k))
        const defaultVals = defaultKeys.map(k => {
            const d = literalToQuery(query.columnDefaults![k], true)
            Object.assign(p, d.p)
            return d.q
        })
        const selectVals = valueSql.map(v => `SELECT ${[v, ...defaultVals].join(', ')}`).join(' UNION ALL ')
        const cteKeysSql = [...keys, ...defaultKeys].map(k => columnify(k)).join(', ')
        // const cteName = 'new_record_cte'
        const cteName = UPDATE_NEW_COL_ID
        q = `WITH ${cteName} (${cteKeysSql}) AS (${selectVals}) ${q} (${keysSql}) `
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
