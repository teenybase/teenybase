import {z} from 'zod'
import {sqlExprSchema, sqlValSchema} from '../../types/sql'
import {JsepContext, parseColumnList} from './jsep'
import {SQLLiteral, SQLQuery} from '../build/query'
import {recordToSqlExpressions, recordToSqlValues} from './parse'
import {InsertQuery} from '../build/insert'

export const insertSchema = z.object({
    values: z.record(sqlValSchema).or(z.array(z.record(sqlValSchema))).optional(),
    expr: z.record(sqlExprSchema).or(z.array(z.record(sqlExprSchema))).optional(),
    returning: z.array(sqlExprSchema).or(sqlExprSchema).optional()
})

export type InsertParams = z.infer<typeof insertSchema>

export async function parseInsertQuery(q: InsertParams, jc: JsepContext){
    const insertData = await insertSchema.parseAsync(q)
    if((!insertData.expr && !insertData.values) || (insertData.expr && insertData.values)){
        throw new Error('Insert query must have either values or expr')
    }
    const values = [] as Record<string, SQLQuery|SQLLiteral>[]
    if(insertData.expr){
        const v = Array.isArray(insertData.expr) ? insertData.expr : [insertData.expr]
        for (let i = 0; i < v.length; i++) {
            const data = v[i]
            if(!data) throw new Error('Insert query must have values or expr ' + i)
            if(!values[i]) values[i] = {}
            Object.assign(values[i], recordToSqlExpressions(data, jc))
        }
    }else if(insertData.values){
        const v = Array.isArray(insertData.values) ? insertData.values : [insertData.values]
        for (let i = 0; i < v.length; i++) {
            const data = v[i]
            if(!data) throw new Error('Insert query must have values or expr ' + i)
            if(!values[i]) values[i] = {}
            Object.assign(values[i], recordToSqlValues(data))
        }
    }
    const insertQuery: InsertQuery = {
        table: jc.tableName,
        returning: insertData.returning ? parseColumnList(insertData.returning, jc, true, true) : undefined,
        values,
        // join
    }
    return insertQuery
}

