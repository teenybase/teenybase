import {z} from 'zod'
import {JsepContext, parseColumnList} from './jsep'
import {DeleteQuery} from '../build/delete'
import {queryToSqlQuery} from './parse'
import {sqlExprSchema} from '../../types/sql'

export const deleteSchema = z.object({
    where: sqlExprSchema,
    returning: z.array(sqlExprSchema).or(sqlExprSchema).optional(),
})

export type DeleteParams = z.infer<typeof deleteSchema>

export async function parseDeleteQuery(q: DeleteParams, jc: JsepContext){
    const deleteData = await deleteSchema.parseAsync(q)

    const deleteQuery: DeleteQuery = {
        table: jc.tableName,
        where: deleteData.where ? queryToSqlQuery(deleteData.where, jc) : undefined,
        returning: deleteData.returning ? parseColumnList(deleteData.returning, jc, true, true) : undefined,
        // join
    }

    return deleteQuery
}
