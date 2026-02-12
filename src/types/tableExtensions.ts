import {TableExtensionData} from './table'

export interface TableRulesExtensionData extends TableExtensionData{
    name: "rules"
    listRule: string | null
    viewRule: string | null
    createRule: string | null
    updateRule: string | null
    deleteRule: string | null
}

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
    passwordResetEmailDuration?: number
    emailVerifyEmailDuration?: number
    autoSendVerificationEmail?: boolean // default = false
    normalizeEmail?: boolean // default = true. converts to lower case, remove + suffix and remove dots from gmail. todo should this be in field level?
    saveIdentities?: boolean // default = false. save external provider identity data (raw profile, provider ID) in _auth_identities table

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

