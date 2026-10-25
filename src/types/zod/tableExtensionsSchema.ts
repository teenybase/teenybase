import {z} from 'zod';
import {sqlExprSchema} from './sqlSchemas';

export const tableRulesDataSchema = z.object({
    name: z.literal('rules'),
    listRule: sqlExprSchema.nullable().default(null),
    viewRule: sqlExprSchema.nullable().default(null),
    createRule: sqlExprSchema.nullable().default(null),
    updateRule: sqlExprSchema.nullable().default(null),
    deleteRule: sqlExprSchema.nullable().default(null),
})
export const emailTemplateSchema = z.object({
    subject: z.string().optional(),
    variables: z.record(z.string(), z.any()).optional(),
    tags: z.array(z.string()).optional(),
    layoutHtml: z.union([z.string(), z.array(z.string())]).optional(),
    layoutText: z.union([z.string(), z.array(z.string())]).optional(),
})
export const tableAuthDataSchema = z.object({
    name: z.literal('auth'),
    jwtSecret: z.string(),
    jwtTokenDuration: z.number(),
    maxTokenRefresh: z.number(),
    passwordType: z.literal('sha256').default('sha256'),
    passwordConfirmSuffix: z.string().optional(),
    passwordCurrentSuffix: z.string().default('Current'),
    passwordResetTokenDuration: z.number().optional(),
    emailVerifyTokenDuration: z.number().optional(),
    passwordResetEmailDuration: z.number().optional(),
    emailVerifyEmailDuration: z.number().optional(),
    autoSendVerificationEmail: z.boolean().optional(),
    saveIdentities: z.boolean().optional(),
    normalizeEmail: z.boolean().optional(),
    emailTemplates: z.object({
        verification: emailTemplateSchema.optional(),
        passwordReset: emailTemplateSchema.optional(),
    }).optional(),
    // onlyVerified: z.boolean().optional(),
    // minPasswordLength: z.number().optional(),
    // onlyEmailDomains: z.array(z.string()).nullable().optional(),
    // exceptEmailDomains: z.array(z.string()).nullable().optional(),
    // allowEmailAuth: z.boolean().optional(),
    // allowUsernameAuth: z.boolean().optional(),
    // allowOAuth2Auth: z.boolean().optional(),
    // manageRule: z.string().nullable().optional(),
})
export const tableExtensionSchemas = {
    rules: tableRulesDataSchema,
    auth: tableAuthDataSchema,
}
