import {AlterTable, TableData} from "./table";
import {BaseTemplateProps} from "./email";
import {MailgunBindings} from "./mailgun";
import {SQLAction} from './sql'
import {ResendBindings} from './resend'
import {CloudflareEmailBindings} from './cloudflare-email'
import {JwtAlgorithm} from '@tsndr/cloudflare-worker-jwt'

export interface EmailSettings {
    /**
     * Default sender address for outgoing emails.
     * Used as fallback when `from` is not provided in individual sendEmail calls.
     */
    from: string
    /** Template variables injected into all outgoing emails (company_name, company_url, etc). */
    variables: BaseTemplateProps

    /** Email tags. Used by Mailgun as-is; converted to `{name, value}` pairs for Resend. */
    tags?: string[]
    /** Mailgun provider config. Provide API key and server details. */
    mailgun?: MailgunBindings
    /** Resend provider config. Provide API key. */
    resend?: ResendBindings
    /**
     * Cloudflare Email Service provider config. Uses a Workers `send_email` binding —
     * no API keys, but the sending domain must be onboarded via `npx wrangler email sending enable <domain>`
     * and the binding declared in wrangler.jsonc. Only takes effect when Mailgun and Resend are unset.
     */
    cloudflare?: CloudflareEmailBindings
    /**
     * When true, emails are logged to console and set in the `X-Mock-Email` response header
     * instead of being sent. Useful for local development and tests.
     * @default false
     */
    mock?: boolean
}

/**
 * Configure cookie-based auth. When set:
 * - `initAuth()` reads the token from this cookie (after checking the Authorization header)
 * - OAuth redirect flows (Google One Tap, OAuth callback) set the cookie automatically
 * - Logout endpoints delete the cookie
 *
 * JSON endpoints (login-password, sign-up, refresh-token) do NOT set the cookie —
 * they return the token in the response body. SSR apps must set the cookie themselves.
 */
export interface AuthCookieConfig {
    /** Cookie name. Must match the name used when setting the cookie in your SSR layer. */
    name: string
    /**
     * @default true
     */
    httpOnly?: boolean
    /**
     * @default true
     */
    secure?: boolean
    /**
     * @default 'Lax'
     */
    sameSite?: 'Strict' | 'Lax' | 'None'
    /**
     * @default '/'
     */
    path?: string
    /** Cookie max age in seconds. When not set, cookie is session-based (deleted when browser closes). */
    maxAge?: number
    /** Cookie domain. When not set, defaults to the current domain. */
    domain?: string
}

/** Unified auth provider config — supports OAuth redirect flow, JWT/Bearer verification, or both.
 *  OAuth redirect is enabled when clientSecret is present. JWT verification is enabled when
 *  jwksUrl/secret is present or auto-detected from a known preset (google, supabase, auth0). */
export interface AuthProvider {
    /** Provider name — used in OAuth route path (/auth/oauth/:name) and for preset auto-detection.
     *  REQUIRED when OAuth is enabled. Optional for JWT-only issuers (identified by issuer URL). */
    name?: string
    /** JWT issuer claim to match — auto-detected for presets (e.g., 'google' → 'https://accounts.google.com') */
    issuer?: string

    // OAuth redirect flow (enabled when clientSecret is present)
    /** OAuth client ID (literal or $ENV_VAR). Also the JWT audience: a token is accepted only when its `aud` (or
     *  `azp`) is one of these. Supports multiple IDs (e.g., Google ios/web/android clients). Required when clientSecret
     *  is set, and for every JWT issuer (`issuer` set, or the `google` preset) in 'login'/'partial' bearerMode; not for
     *  'full'/'admin' (teenybase tokens carry roles in `aud`) or the hosted supabase preset (defaults to 'authenticated'). */
    clientId?: string | string[]
    /** OAuth client secret ($ENV_VAR). When present, enables the OAuth redirect flow. */
    clientSecret?: string
    /**
     * OAuth scopes to request. Auto-filled for known providers:
     * google: `['openid', 'email', 'profile']`, github: `['user:email', 'read:user']`,
     * discord: `['identify', 'email']`, linkedin: `['openid', 'email', 'profile']`.
     * @default [] (or preset scopes for known providers)
     */
    scopes?: string[]
    /**
     * OAuth authorization endpoint URL. Auto-filled for known providers.
     * Required for custom providers (throws 500 if missing).
     */
    authorizeUrl?: string
    /**
     * OAuth token exchange endpoint URL. Auto-filled for known providers.
     * Required for custom providers (throws 500 if missing).
     */
    tokenUrl?: string
    /**
     * Userinfo endpoint URL to fetch user profile after token exchange.
     * Required for providers that don't return an `id_token` (e.g. GitHub, Discord).
     * If the provider returns an `id_token` (e.g. Google), user info is extracted from
     * that instead, and this field is not needed.
     */
    userinfoUrl?: string
    /**
     * URL to redirect the user to after OAuth completes. This is the frontend URL,
     * not the OAuth callback URL (which is handled internally).
     * Not validated (it comes from the config); the `redirect` query is validated against `allowedRedirectUrls` or `appUrl`'s origin.
     * @default appUrl
     */
    redirectUrl?: string
    /**
     * Extra query parameters to add to the OAuth authorization URL.
     * Merged with preset params (config overrides preset).
     * Example: `{access_type: 'offline', prompt: 'consent'}` for Google refresh tokens.
     */
    authorizeParams?: Record<string, string>
    /**
     * Extra headers for the userinfo endpoint request.
     * Merged with default headers (`Authorization: Bearer`, `Accept: application/json`)
     * and preset headers (config overrides both).
     */
    userinfoHeaders?: Record<string, string>
    /**
     * Extract a nested field from the userinfo response JSON.
     * For example, Discord returns `{user: {...}, application: {...}}`,
     * so `userinfoField: 'user'` extracts just the user object.
     */
    userinfoField?: string
    /**
     * Map provider response field names to standard names.
     * Config overrides preset mappings. Fields not mapped are not extracted.
     * @default {email: 'email', name: 'name', verified: 'email_verified'}
     */
    mapping?: {
        /** @default 'email' */
        email?: string
        /** @default 'name' */
        name?: string
        /** No default. Preset examples: google → `'picture'`, github → `'avatar_url'`. */
        avatar?: string
        /** No default. Preset example: github → `'login'`. */
        username?: string
        /**
         * Field name for email verification status. If the field is missing from the
         * provider response, verification falls back to `trustEmailVerified` (default false).
         * @default 'email_verified'
         */
        verified?: string
    }
    /**
     * Trust this provider's email as verified when the verification field is missing: the OAuth
     * response's `mapping.verified` field, or a JWT issuer token's `email_verified` / `verified`
     * claim. An explicit false is never overridden. Use only for providers where email verification
     * is intrinsic to the account (e.g., Google, Apple, LinkedIn, a Supabase project with "Confirm
     * email" on). For untrusted providers (custom IdPs, providers that don't validate email at
     * signup), leave unset: unverified emails never sign in, since linking them to an existing
     * account by email enables pre-account-takeover.
     * @default false
     */
    trustEmailVerified?: boolean

    // JWT/Bearer verification (auto-enabled for known providers with JWKS)
    /** Verification key: HMAC shared secret (string or $ENV_VAR), PEM public key string, or JWK public key object */
    secret?: string | JsonWebKey
    /** JWKS endpoint URL — auto-detected for known providers (google, supabase, auth0) */
    jwksUrl?: string
    /**
     * JWT signing/verification algorithm. For external issuers, if not set,
     * detected from JWK `alg` field or inferred from key type (string → HS256, JWK → RS256).
     * @default 'HS256'
     */
    algorithm?: JwtAlgorithm | string

    /** Controls how this provider's tokens work as Bearer tokens (outside of /auth/login-token):
     *  - 'login' (default): Bearer tokens ignored in initAuth, only usable via /auth/login-token endpoint
     *  - 'partial': Sets auth context with identity fields only (email, verified, iss) — for rules based on auth.email
     *  - 'full': Passes identity + session/user fields (id, cid, sid, meta, aud) — for cross-instance teenybase auth
     *  - 'admin': Same as 'full' but also trusts the admin flag — only for fully trusted instances */
    bearerMode?: 'login' | 'partial' | 'full' | 'admin'
}

export type OAuthExchangeResult = {
    provider?: string           // e.g. 'google', 'github'
    providerId?: string         // user's ID on the external provider
    email: string
    name?: string
    avatar?: string
    username?: string
    verified?: boolean
    rawData?: Record<string, any>  // full provider response
}

/** @deprecated Use AuthProvider instead */
export type AllowedIssuer = string | ({ issuer: string } & Pick<AuthProvider, 'secret' | 'jwksUrl' | 'algorithm' | 'clientId' | 'bearerMode' | 'trustEmailVerified'>)

/**
 * Database adapter configuration. Selects the backend and carries connection info.
 * Serializable JSON — stored in the `$settings` KV row, editable from Pocket UI.
 *
 * Custom adapters may extend this via module augmentation to add fields:
 *   declare module 'teenybase' {
 *     interface DatabaseConfig { syncUrl?: string }
 *   }
 */
export interface DatabaseConfig {
    /**
     * Adapter kind. Known values auto-complete; custom adapter types are allowed
     * via the `(string & {})` pattern and must ship their own `*Extension`.
     */
    type: 'd1-binding' | 'libsql' | 'd1-http' | 'd1-rest' | (string & {})

    /**
     * Wrangler D1 binding name (worker env key).
     * Required when `type === 'd1-binding'`. Unused otherwise.
     */
    binding?: string

    /**
     * Endpoint URL.
     * - `libsql`: `libsql://…`, `wss://…`, `https://…`, `file:…`, `:memory:`
     * - `d1-http`: self-hosted server base URL
     * Required for `libsql` and `d1-http`. Unused by `d1-binding` and `d1-rest`.
     * Prefix with `$` to resolve from env via SecretResolver.
     */
    url?: string

    /**
     * Bearer token sent as `Authorization: Bearer <authToken>`.
     * - `libsql`: Turso auth token or sqld bearer
     * - `d1-http`: bearer the self-hosted server validates
     * Optional for local libsql (`file:` / `:memory:`). Prefix with `$` to resolve from env.
     */
    authToken?: string

    /**
     * Cloudflare REST API credentials. Required when `type === 'd1-rest'`.
     */
    cloudflare?: CloudflareDatabaseConfig
}

export interface CloudflareDatabaseConfig {
    /** Cloudflare account ID. Required when outer type === 'd1-rest'. Prefix with `$`. */
    accountId?: string
    /** Cloudflare D1 database UUID. Required when outer type === 'd1-rest'. Prefix with `$`. */
    databaseId?: string
    /** Cloudflare API token scoped for D1 Edit. Required when outer type === 'd1-rest'. Prefix with `$`. */
    apiToken?: string
}

export interface DatabaseSettings {
    /** Table definitions for the database. */
    tables: TableData[]
    /**
     * Global JWT signing secret. Combined with the table-level jwtSecret (concatenated) to form
     * the actual signing key for table auth tokens. For tokens without a table (`cid`) claim,
     * only this secret is used.
     * Prefix with `$` to resolve from environment variables (e.g. `'$JWT_SECRET'`).
     */
    jwtSecret: string
    /**
     * JWT issuer claim (`iss`) for tokens created by this instance.
     * @default '$db'
     */
    jwtIssuer?: string
    /**
     * JWT signing algorithm.
     * @default 'HS256'
     */
    jwtAlgorithm?: JwtAlgorithm | string

    /** @deprecated Use `authProviders` instead */
    jwtAllowedIssuers?: AllowedIssuer[]

    /**
     * Application name. Used in email templates as the `APP_NAME` variable.
     * @default 'Teeny App'
     */
    appName?: string
    /**
     * Application URL. Required. Used for OAuth redirect validation, JWT `sub` claim generation,
     * and email templates (`APP_URL` variable).
     */
    appUrl: string

    /** Server-side actions with typed params, callable via API. Cannot specify both `sql` and `steps` in an action. */
    actions?: SQLAction[]

    /** Email service config. When not set, email-dependent features (verification, password reset) are unavailable. */
    email?: EmailSettings

    /**
     * Cookie-based auth config. When set, `initAuth()` reads the token from this cookie
     * (in addition to the Authorization header). See {@link AuthCookieConfig} for details.
     */
    authCookie?: AuthCookieConfig

    /** Unified auth provider config — replaces jwtAllowedIssuers */
    authProviders?: AuthProvider[]

    /** Allowed redirect URLs after OAuth login (exact match).
     *  Relative paths in the redirect param are resolved against appUrl before matching.
     *  When not set, only URLs with appUrl's origin (same scheme, host and port) are allowed. List app deep links
     *  (`myapp://callback`) and other origins here.
     *  Example: ['https://myapp.com/dashboard', 'https://staging.myapp.com/callback', 'myapp://callback'] */
    allowedRedirectUrls?: string[]

    /**
     * Database adapter config. Selects which backend the framework talks to.
     * When omitted, defaults to `{type: 'd1-binding', binding: 'PRIMARY_DB'}`.
     * See {@link DatabaseConfig} for per-type fields.
     */
    database?: DatabaseConfig

    /**
     * Deploy-time stamp of the settings version. Written by the CLI after each apply
     * (`nextVersion = (lastVersion ?? -1) + 1`), bundled into the worker via the
     * generated config, and compared against the `DDB_SETTINGS_VERSION` request header
     * to detect frontend/worker skew. Authoritative counter lives in `$settings_version`
     * KV row — this is the worker-side mirror.
     */
    // todo rename to _version
    version?: number

    /** Internal KV table name for storing settings, sessions, and tokens. Must start with `_`. */
    _kvTableName?: string

    // todo implement below in backend
    /** Not yet implemented. Intended to disable/throw error on creating and editing tables. */
    disableTablesEdit?: boolean

    // for comments and notes
    ['//']?: string
}

/** Check if any table in settings has an auth extension with saveIdentities enabled. */
export function hasIdentitiesExtension(settings: DatabaseSettings): boolean {
    return settings.tables.some(t => t.extensions?.some((e: any) => e.name === 'auth' && e.saveIdentities))
}

export type AlterSettings = {create: TableData[], drop: TableData[], alter: AlterTable[]}
