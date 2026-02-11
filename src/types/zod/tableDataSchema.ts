import {z} from 'zod';

import {tableFieldDataSchema} from './tableFieldDataSchema'
import {tableColumnNameSchema, zSQLIndex, zSQLTrigger} from './sqlSchemas'
import {TableFieldUsageRecord} from '../../worker/usages'

export const tableDataSchema = z.object({
    // id: z.string(),
    name: tableColumnNameSchema,
    r2Base: z.string().optional(),
    idInR2: z.coerce.boolean().optional(),
    autoDeleteR2Files: z.coerce.boolean().optional()/*.default(true)*/,
    allowMultipleFileRef: z.coerce.boolean().optional(),
    allowWildcard: z.coerce.boolean().optional(),
    fields: z.array(tableFieldDataSchema),
    indexes: z.array(zSQLIndex).optional(),
    triggers: z.array(zSQLTrigger).optional(),
    autoSetUid: z.coerce.boolean().optional(),
    extensions: z.array(z.record(z.string(), z.any()).and(z.object({name: z.string()}))),
    lastName: tableColumnNameSchema.optional(),
    fullTextSearch: z.object({
        enabled: z.coerce.boolean().optional(),
        fields: z.array(tableColumnNameSchema).min(1),
        tokenize: z.string().optional(),
        prefix: z.string().optional(),
        // content: z.string().optional(),
        contentless: z.coerce.boolean().optional(),
        migrateTableQuery: z.coerce.boolean().default(true),
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
