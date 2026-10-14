import {JsepContext, parseColumnList, parseColumnListOrder,} from './jsep'
import {queryToSqlQuery} from './parse'
import {SelectQuery} from '../build/select'
import {SelectParams} from '../../types/sql'
import {selectSchema} from '../../types/zod/sqlSchemas';

export function parseSelectQuery(q: SelectParams, jc: JsepContext){
    const selectData = selectSchema.parse(q)
    // sort is an alias for order (PocketBase/PocketUI convention)
    const order = selectData.order || selectData.sort
    const select: SelectQuery = {
        selects: selectData.select ? parseColumnList(selectData.select, jc, true, true, true) : undefined,
        from: jc.tableName,
        where: selectData.where ? queryToSqlQuery(selectData.where, jc) : undefined,
        groupBy: selectData.group ? parseColumnList(selectData.group, jc, false, false) : undefined,
        orderBy: order ? parseColumnListOrder(order, jc) : undefined,
        limit: selectData.limit,
        offset: selectData.offset,
        distinct: selectData.distinct,
        // having: selectData.having ? queryToD1Query(selectData.having, table, c) : undefined,
        // selectOption: selectData
        // join
    }
    let readOnly = !select.selects || select.selects?.every(s=>typeof s==='string' || s._readOnly)
    readOnly = readOnly && !!(Array.isArray(select.where) ? select.where.every(s=>!s.q || s._readOnly) : (!select.where?.q || select.where?._readOnly))
    // todo having

    if(readOnly) select._readOnly = true

    return select
}
