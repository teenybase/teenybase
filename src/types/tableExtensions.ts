import {TableExtensionData} from './table'
import {z} from 'zod'
import {sqlExprSchema} from './sql'

export interface TableRulesExtensionData extends TableExtensionData{
    name: "rules"
    listRule: string | null
    viewRule: string | null
    createRule: string | null
    updateRule: string | null
    deleteRule: string | null
}

export const tableRulesDataSchema = z.object({
    name: z.literal('rules'),
    listRule: sqlExprSchema.nullable().default(null),
    viewRule: sqlExprSchema.nullable().default(null),
    createRule: sqlExprSchema.nullable().default(null),
    updateRule: sqlExprSchema.nullable().default(null),
    deleteRule: sqlExprSchema.nullable().default(null),
})

export type PasswordTypes = 'sha256'

export interface TableAuthExtensionData extends TableExtensionData {
    name: "auth"
    jwtSecret: string
    jwtTokenDuration: number
    maxTokenRefresh: number  // number of times token can be refreshed. set to 0 to disable.
    passwordType: PasswordTypes
    passwordConfirmSuffix?: string // Confirm
    passwordCurrentSuffix?: string // Current
    passwordResetTokenDuration?: number
    emailVerifyTokenDuration?: number
    autoSendVerificationEmail?: boolean // default = false

    emailTemplates?: Partial<Record<'verification' | 'passwordReset', {
        subject?: string,
        variables?: Record<string, any>
        tags?: string,
        layoutHtml?: string
    }>>

    // todo implement these in backend
    // onlyVerified?: boolean // only allow auth for verified users
    // minPasswordLength?: number // default = 8?
    // onlyEmailDomains?: string[]|null // only allow certain email domains
    // exceptEmailDomains?: string[]|null // do not allow certain email domains
    // allowEmailAuth?: boolean // allow email based auth
    // allowUsernameAuth?: boolean // allow username based auth
    // allowOAuth2Auth?: boolean // allow oauth2 based auth
    // manageRule?: string | null // allow oauth2 based auth

    // todo
    // requireEmail?: boolean // always require when email field exists or dictate by not null?
}

export const emailTemplateSchema = z.object({
    subject: z.string().optional(),
    variables: z.record(z.any()).optional(),
    tags: z.string().optional(),
    layoutHtml: z.string().optional(),
})

export const tableAuthDataSchema = z.object({
    name: z.literal('auth'),
    jwtSecret: z.string(),
    jwtTokenDuration: z.number(),
    maxTokenRefresh: z.number(),
    passwordType: z.literal('sha256').default('sha256'),
    passwordConfirmSuffix: z.string().optional(),
    passwordCurrentSuffix: z.string().optional(),
    passwordResetTokenDuration: z.number().optional(),
    emailVerifyTokenDuration: z.number().optional(),
    autoSendVerificationEmail: z.coerce.boolean().optional(),
    emailTemplates: z.object({
        verification: emailTemplateSchema.optional(),
        passwordReset: emailTemplateSchema.optional(),
    }).optional(),
    // onlyVerified: z.coerce.boolean().optional(),
    // minPasswordLength: z.number().optional(),
    // onlyEmailDomains: z.array(z.string()).nullable().optional(),
    // exceptEmailDomains: z.array(z.string()).nullable().optional(),
    // allowEmailAuth: z.coerce.boolean().optional(),
    // allowUsernameAuth: z.coerce.boolean().optional(),
    // allowOAuth2Auth: z.coerce.boolean().optional(),
    // manageRule: z.string().nullable().optional(),
})

export const tableExtensionSchemas = {
    rules: tableRulesDataSchema,
    auth: tableAuthDataSchema,
}
