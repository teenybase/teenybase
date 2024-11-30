import {z} from 'zod'

export const sqlExprSchema = z.string().max(1000).regex(/^[a-zA-Z0-9_=\s():.*~%'"><!+\-&|@,\/\\${}]*$/)

export const sqlValSchema = z.string().or(z.number()).or(z.boolean()).or(z.null())
export const sqlValSchemaFile = z.coerce.boolean().or(z.string().or(z.number()).or(z.null()).or(z.instanceof(File)))
export const sqlValSchema2 = sqlValSchema.or(z.record(sqlValSchema))
export const sqlValSchemaFile2 = z.record(sqlValSchemaFile)
export const sqlValSchemaFile3 = z.array(sqlValSchemaFile2).or(sqlValSchemaFile2)

export const sqlColListSchema = z.string().regex(/^[a-zA-Z0-9_,\s]*$/).or(z.literal('*'))
export const sqlColListSchemaOrder = z.string().regex(/^[a-zA-Z0-9_,\s+-]*$/)

// for search query params
export const sqlColListSchema2 = z.array(sqlColListSchema).or(sqlColListSchema)
export const sqlColListSchemaOrder2 = z.array(sqlColListSchemaOrder).or(sqlColListSchemaOrder)

// not final, cant pass in query param
// export const joinObjSchema = z.object({
//     table: z.string(),
//     on: sqlExprSchema,
//     type: z.string().optional(),
// })
// export const joinObjSchema2 = z.array(joinObjSchema).or(joinObjSchema)

export const tableColumnNameSchema = z.string()
    .min(1).max(255)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Table/Column name must start with a letter or underscore and can only contain letters, numbers and underscores')
//.or(z.literal('*')) // todo *
