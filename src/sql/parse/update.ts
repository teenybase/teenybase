import {JsepContext, parseColumnList} from './jsep'
import {queryToSqlQuery, recordToSqlExpressions, recordToSqlValues} from './parse'
import {UPDATE_NEW_COL_ID, UpdateQuery} from '../build/update'
import {UpdateParams} from '../../types/sql'
import {updateSchema} from '../../types/zod/sqlSchemas';

export function parseUpdateQuery(q: UpdateParams, jc: JsepContext) {
    const updateData = updateSchema.parse(q)

    // todo - support both set and setValues.
    if ((!updateData.set && !updateData.setValues) || (updateData.set && updateData.setValues)) {
        throw new Error('Update query must have either set or setValues')
    }
    const set = updateData.set ? recordToSqlExpressions(updateData.set, jc) :
        updateData.setValues ? recordToSqlValues(updateData.setValues) : {}

    if(!Object.keys(set).length) throw new Error('Update query must have set or setValues with at least one field')

    // note -
    //  since we are replacing as literal,
    //  its possible to have queries like
    //  `new.owner = notes.owner` will become `[notes].[owner] = [notes].[owner]`
    //  todo - so this should be simplified to true. is it done?

    // allows new.* in where and rule
    const contextWithNew: JsepContext = {
        ...jc, extras: { ...jc.extras,
        [UPDATE_NEW_COL_ID]: {
            table: jc.tableName,
            literals: set
        }}
    }
    const updateQuery: UpdateQuery = {
        table: jc.tableName,
        where: updateData.where ? queryToSqlQuery(updateData.where, contextWithNew) : undefined,
        returning: updateData.returning ? parseColumnList(updateData.returning, jc, true, true) : undefined,
        set,
        contextWithNew: contextWithNew,
        or: updateData.or,
        // join
    }

    return updateQuery
}

