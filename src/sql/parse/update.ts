import {z} from 'zod'
import {sqlExprSchema, sqlValSchema, zOnConflict} from '../../types/sql'
import {JsepContext, parseColumnList} from './jsep'
import {queryToSqlQuery, recordToSqlExpressions, recordToSqlValues} from './parse'
import {UPDATE_NEW_COL_ID, UpdateQuery} from '../build/update'

export const updateSchema = z.object({
    or: zOnConflict.optional(),
    set: z.record(sqlExprSchema).optional(),
    setValues: z.record(sqlValSchema).optional(),
    where: sqlExprSchema,
    returning: z.array(sqlExprSchema).or(sqlExprSchema).optional()
})

export type UpdateParams = z.infer<typeof updateSchema>

export async function parseUpdateQuery(q: UpdateParams, jc: JsepContext) {
    const updateData = await updateSchema.parseAsync(q)
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
    //  todo - so this should be simplified to true.

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

