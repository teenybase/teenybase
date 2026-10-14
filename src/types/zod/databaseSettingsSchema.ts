import {z} from 'zod';
import {tableDataSchema} from './tableDataSchema'
import {zSQLAction} from './sqlSchemas'
import {baseTemplatePropsSchema} from './emailTemplatePropsSchema'
import {mailgunBindingsSchema} from './mailgunBindingsSchema'
import {resendBindingsSchema} from './resendBindingsSchema'
import {cloudflareEmailBindingsSchema} from './cloudflareEmailBindingsSchema'
import {allowedIssuerSchema, authProviderSchema} from './jwtSchemas'

export const databaseConfigSchema = z.object({
    type: z.string().min(1),
    binding: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    authToken: z.string().optional(),
    cloudflare: z.object({
        accountId: z.string().optional(),
        databaseId: z.string().optional(),
        apiToken: z.string().optional(),
    }).optional(),
}).passthrough().superRefine((data, ctx) => {
    switch (data.type) {
        case 'd1-binding':
            if (!data.binding) ctx.addIssue({
                code: 'custom', path: ['binding'],
                message: 'binding is required when type="d1-binding"',
            })
            break
        case 'libsql':
        case 'd1-http':
            if (!data.url) ctx.addIssue({
                code: 'custom', path: ['url'],
                message: `url is required when type="${data.type}"`,
            })
            break
        case 'd1-rest':
            for (const f of ['accountId', 'databaseId', 'apiToken'] as const) {
                if (!data.cloudflare?.[f]) ctx.addIssue({
                    code: 'custom', path: ['cloudflare', f],
                    message: `cloudflare.${f} is required when type="d1-rest"`,
                })
            }
            break
        // custom types: their own *Extension.init() is responsible for validation.
    }
})

export const databaseSettingsSchema = z.object({
    tables: z.array(tableDataSchema),
    jwtSecret: z.string(),
    jwtIssuer: z.string().optional(),
    jwtAlgorithm: z.string().optional(),
    jwtAllowedIssuers: z.array(allowedIssuerSchema).optional(),
    version: z.number().optional(),
    appName: z.string().optional(),
    appUrl: z.string(),
    actions: z.array(zSQLAction).optional(),
    email: z.object({
        from: z.string(),
        variables: baseTemplatePropsSchema,
        tags: z.array(z.string()).optional(),
        mailgun: mailgunBindingsSchema.optional(),
        resend: resendBindingsSchema.optional(),
        cloudflare: cloudflareEmailBindingsSchema.optional(),
        mock: z.boolean().optional(),
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
    authProviders: z.array(authProviderSchema).optional(),
    allowedRedirectUrls: z.array(z.string()).optional(),
    database: databaseConfigSchema.optional(),
    _kvTableName: z.string().startsWith('_', {message: 'Internal table name must start with _ (underscore)'}).optional(),
    disableTablesEdit: z.boolean().optional(),
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
