import {z} from 'zod'
import {
    JsepContext,
    parseColumnList,
    parseColumnListOrder,
} from './jsep'
import {queryToSqlQuery} from './parse'
import {sqlColListSchema2, sqlColListSchemaOrder2, sqlExprSchema} from '../../types/sql'
import {SelectQuery} from '../build/select'

export const selectSchema = z.object({
    where: sqlExprSchema.optional(),
    limit: z.coerce.number().optional(),
    offset: z.coerce.number().optional(),
    order: sqlColListSchemaOrder2.optional(),
    group: sqlColListSchema2.optional(),
    select: sqlExprSchema.or(z.array(sqlExprSchema)).optional(), // todo rename to fields in api v2
    distinct: z.coerce.boolean().optional(),
    // join: joinObjSchema2.array().optional(),
    // having: z.string().regex(/^[a-zA-Z0-9_=\s\(\)\.\*]*$/).optional(),
    // selectOption: z.string().optional(),
})

export type SelectParams = z.infer<typeof selectSchema>

export async function parseSelectQuery(q: SelectParams, jc: JsepContext){
    const selectData = await selectSchema.parseAsync(q)
    const select: SelectQuery = {
        selects: selectData.select ? parseColumnList(selectData.select, jc, true, true) : undefined,
        from: jc.tableName,
        where: selectData.where ? queryToSqlQuery(selectData.where, jc) : undefined,
        groupBy: selectData.group ? parseColumnList(selectData.group, jc, false, false) : undefined,
        orderBy: selectData.order ? parseColumnListOrder(selectData.order, jc) : undefined,
        limit: selectData.limit,
        offset: selectData.offset,
        distinct: selectData.distinct,
        // having: selectData.having ? queryToD1Query(selectData.having, table, c) : undefined,
        // selectOption: selectData
        // join
    }
    return select
}
