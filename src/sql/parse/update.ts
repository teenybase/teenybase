import {z} from 'zod'
import {sqlExprSchema, sqlValSchema} from '../../types/sql'
import {JsepContext, parseColumnList} from './jsep'
import {queryToSqlQuery, recordToSqlExpressions, recordToSqlValues} from './parse'
import {UPDATE_NEW_COL_ID, UpdateQuery} from '../build/update'

export const updateSchema = z.object({
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

    // allows new.* in where and rule
    const jc2: JsepContext = {
        ...jc, extras: { ...jc.extras,
        [UPDATE_NEW_COL_ID]: {
            table: jc.tableName,
            literals: set
        }}
    }
    const updateQuery: UpdateQuery = {
        table: jc.tableName,
        where: updateData.where ? queryToSqlQuery(updateData.where, jc2) : undefined,
        returning: updateData.returning ? parseColumnList(updateData.returning, jc, true, true) : undefined,
        set,
        contextWithNew: jc2,
        // join
    }

    return updateQuery
}

