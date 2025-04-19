import {z} from 'zod'
import {JsepContext, jsepParse, treeToSql} from './jsep'
import {SQLLiteral, SQLQuery} from '../../types/sql'
import {sqlValSchema} from '../../types/zod/sqlSchemas';

export function queryToSqlQuery(query: string, c: JsepContext): SQLQuery|SQLLiteral {
    // remove quotes from starting and end - todo is it required?
    // if(query.startsWith('"') && query.endsWith('"')){
    //     query = query.substring(1, query.length-1)
    // }
    // if(query.startsWith('\'') && query.endsWith('\'')){
    //     query = query.substring(1, query.length-1)
    // }

    if(typeof query !== 'string') throw new Error('Query must be a string')

    // console.log(query)
    const tree = jsepParse(query/*, c.globals*/)
    // console.log(tree)
    const sqlQuery = (treeToSql(tree, c))
    // console.log(sqlQuery)
    return sqlQuery
}

// note that this doesn't prefix with the table name in the keys. it has to be done when generating sql if required
export function recordToSqlValues(data: Record<string, z.infer<typeof sqlValSchema>>): Record<string, SQLLiteral> {
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [(k), {l: v}]))
}

// note that this doesn't prefix with the table name in the keys. it has to be done when generating sql
export function recordToSqlExpressions(data: Record<string, string>, c: JsepContext) {
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [(k), queryToSqlQuery(v, c)]))
}
