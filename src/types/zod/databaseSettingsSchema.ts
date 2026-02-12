import {z} from 'zod';
import {tableDataSchema} from './tableDataSchema'
import {zSQLProcedure} from './sqlSchemas'
import {baseTemplatePropsSchema} from './emailTemplatePropsSchema'
import {mailgunBindingsSchema} from './mailgunBindingsSchema'
import {resendBindingsSchema} from './resendBindingsSchema'
import {allowedIssuerSchema} from './jwtSchemas'

export const databaseSettingsSchema = z.object({
    tables: z.array(tableDataSchema),
    jwtSecret: z.string(),
    jwtIssuer: z.string().optional(),
    jwtAlgorithm: z.string().optional(),
    jwtAllowedIssuers: z.array(allowedIssuerSchema).optional(),
    version: z.number().optional(),
    appName: z.string().optional(),
    appUrl: z.string(),
    procedures: z.array(zSQLProcedure).optional(),
    email: z.object({
        from: z.string(),
        variables: baseTemplatePropsSchema,
        tags: z.array(z.string()).optional(),
        mailgun: mailgunBindingsSchema.optional(),
        resend: resendBindingsSchema.optional(),
    }).optional(),
    authCookie: z.object({
        name: z.string().min(1),
        httpOnly: z.boolean().optional(),
        secure: z.boolean().optional(),
        sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
        path: z.string().optional(),
        maxAge: z.number().optional(),
        domain: z.string().optional(),
    }).optional(),
    oauthProviders: z.array(z.object({
        name: z.string().min(1),
        authorizeUrl: z.string().url().optional(),
        tokenUrl: z.string().url().optional(),
        userinfoUrl: z.string().url().optional(),
        clientId: z.string().min(1),
        clientSecret: z.string().min(1),
        scopes: z.array(z.string()).optional(),
        redirectUrl: z.string().optional(),
        authorizeParams: z.record(z.string(), z.string()).optional(),
        userinfoHeaders: z.record(z.string(), z.string()).optional(),
        userinfoField: z.string().optional(),
        mapping: z.object({
            email: z.string().optional(),
            name: z.string().optional(),
            avatar: z.string().optional(),
            username: z.string().optional(),
            verified: z.string().optional(),
        }).optional(),
    })).optional(),
    _kvTableName: z.string().startsWith('_', {message: 'Internal table name must start with _ (underscore)'}).optional(),
    disableTablesEdit: z.coerce.boolean().optional(),
}).superRefine((data, ctx) => {
    // Duplicate table names
    const tableNames = new Set<string>()
    for (const table of data.tables) {
        if (tableNames.has(table.name)) {
            ctx.addIssue({code: "custom", message: `Table ${table.name} - Duplicate table name`, path: ['tables']})
        }
        tableNames.add(table.name)
    }

    // Foreign key references: target table/column exists, sqlType matches
    for (const table of data.tables) {
        for (const field of table.fields) {
            if (field.foreignKey) {
                const targetTable = data.tables.find(t => t.name === field.foreignKey!.table)
                const targetField = targetTable?.fields.find(f => f.name === field.foreignKey!.column)
                if (!targetField) {
                    ctx.addIssue({code: "custom", message: `Table Field ${table.name}:${field.name} - Foreign key field not found - ${field.foreignKey.table}.${field.foreignKey.column}`, path: ['tables']})
                } else {
                    if (field.sqlType !== targetField.sqlType) {
                        ctx.addIssue({code: z.ZodIssueCode.custom, message: `Table Field ${table.name}:${field.name} - Foreign key field sqlType mismatch - ${field.sqlType} !== ${targetField.sqlType}`, path: ['tables']})
                    }
                }
            }
        }
    }
})
