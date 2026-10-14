import {z} from 'zod';

import {tableFieldDataSchema} from './tableFieldDataSchema'
import {tableColumnNameSchema, zSQLIndex, zSQLTrigger} from './sqlSchemas'
import {TableFieldUsageAuth, TableFieldUsageRecord} from '../../worker/usages'

export const tableDataSchema = z.object({
    // id: z.string(),
    name: tableColumnNameSchema,
    r2Base: z.string().optional(),
    idInR2: z.boolean().optional(),
    autoDeleteR2Files: z.boolean().optional()/*.default(true)*/,
    allowMultipleFileRef: z.boolean().optional(),
    allowWildcard: z.boolean().optional(),
    fields: z.array(tableFieldDataSchema),
    indexes: z.array(zSQLIndex).optional(),
    triggers: z.array(zSQLTrigger).optional(),
    autoSetUid: z.boolean().optional(),
    extensions: z.array(z.record(z.string(), z.any()).and(z.object({name: z.string()}))).default([]),
    public: z.boolean().optional(),
    lastName: tableColumnNameSchema.optional(),
    fullTextSearch: z.object({
        enabled: z.boolean().optional(),
        fields: z.array(tableColumnNameSchema).min(1),
        tokenize: z.string().optional(),
        prefix: z.string().optional(),
        // content: z.string().optional(),
        contentless: z.boolean().optional(),
        migrateTableQuery: z.boolean().default(true),
        content_rowid: z.string().optional(),
        columnsize: z.literal(0).or(z.literal(1)).optional(),
        detail: z.enum(["full", "column", "none"]).optional(),
    }).optional(),
}).superRefine((data, ctx) => {
    // Duplicate field names
    const fieldNames = new Set<string>()
    for (const field of data.fields) {
        if (fieldNames.has(field.name)) {
            ctx.addIssue({code: "custom", message: `Field ${data.name}:${field.name} - Duplicate field name`, path: ['fields']})
        }
        fieldNames.add(field.name)
    }

    // idInR2 checks
    if (data.idInR2) {
        const idField = data.fields.find(f => f.usage === TableFieldUsageRecord.record_uid)
        if (!idField || !idField.noUpdate) {
            ctx.addIssue({code: "custom", message: `Table ${data.name} - idInR2 requires an id field with 'usage' = 'record_uid' and 'noUpdate' = 'true'.`, path: ['idInR2']})
        }
        if (data.allowMultipleFileRef) {
            ctx.addIssue({code: "custom", message: `Table ${data.name} - allowMultipleFileRef cannot be true when idInR2 is true`, path: ['allowMultipleFileRef']})
        }
    }

    // allowMultipleFileRef checks
    if (data.allowMultipleFileRef) {
        if (data.idInR2) {
            ctx.addIssue({code: "custom", message: `Table ${data.name} - idInR2 cannot be true when allowMultipleFileRef is true`, path: ['idInR2']})
        }
        const autoDeleteR2Files = data.autoDeleteR2Files ?? true
        if (autoDeleteR2Files) {
            ctx.addIssue({code: "custom", message: `Table ${data.name} - autoDeleteR2Files must be false when allowMultipleFileRef is true`, path: ['autoDeleteR2Files']})
        }
    }

    // public opts a table out of default-deny; a rules extension already defines access, so having
    // both is ambiguous (which one wins?) and is rejected instead of silently ignoring one.
    if (data.public && data.extensions.some(e => e.name === 'rules')) {
        ctx.addIssue({code: "custom", message: `Table ${data.name} - 'public: true' cannot be combined with a rules extension. Remove 'public' to use the rules, or remove the rules extension to make every operation public.`, path: ['public']})
    }

    // allowWildcard not supported
    if (data.allowWildcard) {
        ctx.addIssue({code: "custom", message: `Table ${data.name} - allowWildcard is not supported yet`, path: ['allowWildcard']})
    }

    // autoSetUid requires record_uid with type text
    if (data.autoSetUid) {
        const idField = data.fields.find(f => f.usage === TableFieldUsageRecord.record_uid)
        if (!idField || idField.type !== 'text') {
            ctx.addIssue({code: "custom", message: `Table ${data.name} - autoSetUid requires an id field with 'usage' = 'record_uid' and 'type' = 'text'.`, path: ['autoSetUid']})
        }
    }

    // Auth is the only extension limited to one instance per table, so it is checked
    // explicitly here (a generic per-extension instance limit is tracked as an issue).
    // Auth extension checks. These turn common runtime-only auth failures into
    // config/build errors with the exact missing field usage.
    const authExtensionIndexes = data.extensions
        .map((e, i) => e.name === 'auth' ? i : -1)
        .filter(i => i >= 0)
    if (authExtensionIndexes.length) {
        if (authExtensionIndexes.length > 1) {
            ctx.addIssue({code: "custom", message: `Table ${data.name} - only one auth extension is supported`, path: ['extensions']})
        }

        const fieldsByUsage = new Map<string, {name: string; index: number}[]>()
        data.fields.forEach((field, index) => {
            if (!field.usage) return
            const existing = fieldsByUsage.get(field.usage) ?? []
            existing.push({name: field.name, index})
            fieldsByUsage.set(field.usage, existing)
        })

        const singleUseUsages = [
            TableFieldUsageRecord.record_uid,
            TableFieldUsageRecord.record_created,
            TableFieldUsageRecord.record_updated,
            TableFieldUsageAuth.auth_username,
            TableFieldUsageAuth.auth_email,
            TableFieldUsageAuth.auth_email_verified,
            TableFieldUsageAuth.auth_password,
            TableFieldUsageAuth.auth_password_salt,
            TableFieldUsageAuth.auth_name,
            TableFieldUsageAuth.auth_avatar,
            TableFieldUsageAuth.auth_metadata,
        ]
        for (const usage of singleUseUsages) {
            const fields = fieldsByUsage.get(usage) ?? []
            if (fields.length > 1) {
                ctx.addIssue({
                    code: "custom",
                    message: `Table ${data.name} - usage '${usage}' must be assigned to only one field; found ${fields.map(f => f.name).join(', ')}`,
                    path: ['fields', fields[1].index, 'usage'],
                })
            }
        }

        const authExtensionPath = ['extensions', authExtensionIndexes[0]]
        const requireUsage = (usage: TableFieldUsageRecord | TableFieldUsageAuth) => {
            if (!fieldsByUsage.get(usage)?.length) {
                ctx.addIssue({
                    code: "custom",
                    message: `Table ${data.name} auth extension requires a field with usage '${usage}'`,
                    path: authExtensionPath,
                })
            }
        }
        requireUsage(TableFieldUsageRecord.record_uid)
        requireUsage(TableFieldUsageAuth.auth_username)
        requireUsage(TableFieldUsageAuth.auth_email)
        requireUsage(TableFieldUsageAuth.auth_password)

        if (!data.autoSetUid) {
            ctx.addIssue({
                code: "custom",
                message: `Table ${data.name} auth extension requires autoSetUid: true so password and OAuth sign-up can create user ids`,
                path: ['autoSetUid'],
            })
        }

        const authPopulatedUsages = new Set<string>([
            TableFieldUsageRecord.record_uid,
            TableFieldUsageAuth.auth_username,
            TableFieldUsageAuth.auth_email,
            TableFieldUsageAuth.auth_email_verified,
            TableFieldUsageAuth.auth_password,
            TableFieldUsageAuth.auth_password_salt,
            TableFieldUsageAuth.auth_name,
        ])
        data.fields.forEach((field, index) => {
            if (!field.notNull || field.primary || field.default !== undefined) return
            if (field.usage && authPopulatedUsages.has(field.usage)) return
            ctx.addIssue({
                code: "custom",
                message: `Table ${data.name} auth extension cannot auto-populate NOT NULL field '${field.name}'. Add a default, make it nullable, or assign a supported auth usage.`,
                path: ['fields', index, 'notNull'],
            })
        })

        const username = (fieldsByUsage.get(TableFieldUsageAuth.auth_username) ?? [])[0]
        const email = (fieldsByUsage.get(TableFieldUsageAuth.auth_email) ?? [])[0]
        const password = (fieldsByUsage.get(TableFieldUsageAuth.auth_password) ?? [])[0]
        if (username && !data.fields[username.index].unique) {
            ctx.addIssue({code: "custom", message: `Table ${data.name} auth username field '${username.name}' should be unique`, path: ['fields', username.index, 'unique']})
        }
        if (email && !data.fields[email.index].unique) {
            ctx.addIssue({code: "custom", message: `Table ${data.name} auth email field '${email.name}' should be unique`, path: ['fields', email.index, 'unique']})
        }
        if (password && !data.fields[password.index].noSelect) {
            ctx.addIssue({code: "custom", message: `Table ${data.name} auth password field '${password.name}' must set noSelect: true`, path: ['fields', password.index, 'noSelect']})
        }
    }

    // Full text search checks
    if (data.fullTextSearch) {
        if (!data.fullTextSearch.fields.length) {
            ctx.addIssue({code: "custom", message: `Table ${data.name} - Full text search fields must be set`, path: ['fullTextSearch', 'fields']})
        }
        const invalidFields = data.fullTextSearch.fields.filter(f => !data.fields.find(f2 => f2.name === f))
        if (invalidFields.length) {
            ctx.addIssue({code: "custom", message: `Table ${data.name} - Invalid full text search fields - ${invalidFields.join(', ')}`, path: ['fullTextSearch', 'fields']})
        }
        if (data.fullTextSearch.tokenize && !['unicode61', 'ascii', 'porter', 'trigram'].includes(data.fullTextSearch.tokenize)) {
            ctx.addIssue({code: "custom", message: `Table ${data.name} - Invalid tokenize value - ${data.fullTextSearch.tokenize}`, path: ['fullTextSearch', 'tokenize']})
        }
        if (!data.fullTextSearch.contentless && data.fullTextSearch.content_rowid) {
            ctx.addIssue({code: "custom", message: `Table ${data.name} - content_rowid must not be set when contentless is false`, path: ['fullTextSearch', 'content_rowid']})
        }
        if (data.fullTextSearch.content_rowid) {
            const field = data.fields.find(f => f.name === data.fullTextSearch!.content_rowid)
            if (!field) {
                ctx.addIssue({code: "custom", message: `Table ${data.name} - content_rowid field not found - ${data.fullTextSearch!.content_rowid}`, path: ['fullTextSearch', 'content_rowid']})
            } else {
                if (field.sqlType !== 'integer') {
                    ctx.addIssue({code: "custom", message: `Table ${data.name} - content_rowid field must be integer`, path: ['fullTextSearch', 'content_rowid']})
                }
                if (field.foreignKey) {
                    ctx.addIssue({code: "custom", message: `Table ${data.name} - content_rowid field cannot have foreign key`, path: ['fullTextSearch', 'content_rowid']})
                }
                // todo should be primary?
            }
        }
    }
})
