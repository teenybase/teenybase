import {JsepContext, parseColumnList} from './jsep'
import {DeleteQuery} from '../build/delete'
import {queryToSqlQuery} from './parse'
import {DeleteParams} from '../../types/sql'
import {deleteSchema} from '../../types/zod/sqlSchemas'

export function parseDeleteQuery(q: DeleteParams, jc: JsepContext){
    const deleteData = deleteSchema.parse(q)

    const deleteQuery: DeleteQuery = {
        table: jc.tableName,
        where: deleteData.where ? queryToSqlQuery(deleteData.where, jc) : undefined,
        returning: deleteData.returning ? parseColumnList(deleteData.returning, jc, true, true) : undefined,
        // join
    }

    return deleteQuery
}
