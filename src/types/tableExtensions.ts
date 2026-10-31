import {TableExtensionData} from './table'

export interface TableRulesExtensionData extends TableExtensionData{
    name: "rules"
    /**
     * Expression filter for list/select queries. Converted to a SQL WHERE clause.
     * `null` blocks all non-admin access (403). Admin requests bypass all rules.
     */
    listRule: string | null
    /**
     * Expression filter for single-record view. Converted to a SQL WHERE clause.
     * `null` blocks all non-admin access (403). Admin requests bypass all rules.
     */
    viewRule: string | null
    /**
     * Expression guard for insert operations. Evaluated against the new record values at parse time.
     * `null` blocks all non-admin access (403). Admin requests bypass all rules.
     */
    createRule: string | null
    /**
     * Expression filter for update operations. Converted to a SQL WHERE clause.
     * `null` blocks all non-admin access (403). Admin requests bypass all rules.
     */
    updateRule: string | null
    /**
     * Expression filter for delete operations. Converted to a SQL WHERE clause.
     * `null` blocks all non-admin access (403). Admin requests bypass all rules.
     */
    deleteRule: string | null
}

export type PasswordTypes = 'sha256'

export interface TableAuthExtensionData extends TableExtensionData {
    name: "auth"
    /**
     * Table-level JWT signing secret. Concatenated with the global `DatabaseSettings.jwtSecret`
     * to form the actual signing key (globalSecret + tableSecret).
     * Prefix with `$` to resolve from environment variables (e.g. `'$JWT_SECRET'`).
     */
    jwtSecret: string
    /** JWT access token expiry in seconds. Required. */
    jwtTokenDuration: number
    /** Maximum number of times a token can be refreshed before requiring re-login. Set to 0 for unlimited. Required. */
    maxTokenRefresh: number
    /**
     * Password hashing algorithm. Currently only `'sha256'` is supported.
     * @default 'sha256'
     */
    passwordType: PasswordTypes
    /**
     * Suffix appended to the password field name to create an additional request body field
     * for password confirmation. For example, if the password field is `password` and suffix
     * is `'Confirm'`, the sign-up/update request body must include both `password` and
     * `passwordConfirm` with matching values. The confirm field is validated and then
     * stripped before storage.
     * When not set, only the password field is required.
     */
    passwordConfirmSuffix?: string
    /**
     * Suffix appended to the password field name to create an additional request body field
     * for current password verification. For example, if the password field is `password` and
     * suffix is `'Current'`, `POST /auth/change-password` (and a non-admin record update that sets
     * the password) must include `passwordCurrent` containing the user's existing password.
     * Verified against the stored hash before allowing the change. Only enforced for non-admin users.
     * Unset means `'Current'`. Set to empty string to disable (not recommended).
     * @default 'Current'
     */
    passwordCurrentSuffix?: string
    /**
     * Password reset token validity in seconds.
     * @default 3600 (1 hour)
     */
    passwordResetTokenDuration?: number
    /**
     * Email verification token validity in seconds.
     * @default 3600 (1 hour)
     */
    emailVerifyTokenDuration?: number
    /**
     * Minimum interval in seconds between password reset emails to prevent spam.
     * @default 120 (2 minutes)
     */
    passwordResetEmailDuration?: number
    /**
     * Minimum interval in seconds between verification emails to prevent spam.
     * @default 120 (2 minutes)
     */
    emailVerifyEmailDuration?: number
    /**
     * Automatically send a verification email on sign-up. Requires email service to be configured.
     * @default false
     */
    autoSendVerificationEmail?: boolean
    /**
     * Normalize email addresses before storage and lookup.
     * Applies: lowercase, trim, punycode domain normalization, and provider-specific rules
     * (gmail/googlemail: remove dots and plus-addressing, hotmail/outlook/yahoo: remove plus-addressing).
     * @default true
     */
    normalizeEmail?: boolean
    /**
     * Save OAuth provider identity data (raw profile, provider ID) in the `_auth_identities` table.
     * @default false
     */
    saveIdentities?: boolean

    /** Custom email templates for verification and password reset emails. */
    emailTemplates?: Partial<Record<'verification' | 'passwordReset', {
        subject?: string,
        variables?: Record<string, any>
        /** Extra email tags, added to the built-in ones for this email (see `email.tags`). */
        tags?: string[],
        layoutHtml?: string | string[]
        layoutText?: string | string[]
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
