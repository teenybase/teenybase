import {z} from 'zod';

/** Issuer of Google ID tokens (the `google` preset). */
export const GOOGLE_ISSUER_PATTERN = /^https:\/\/accounts\.google\.com$/
/** Issuer of Supabase-hosted projects' access tokens (the `supabase` preset): `https://<ref>.supabase.co/auth/v1`. */
export const SUPABASE_ISSUER_PATTERN = /^https:\/\/[^/]+\.supabase\.co\/auth\/v1$/
/** `aud` of Supabase user access tokens. The supabase preset checks it when no clientId is set. */
export const SUPABASE_DEFAULT_AUDIENCE = 'authenticated'

/**
 * clientId is required for an issuer whose tokens can sign users in or identify them ('login' / 'partial' bearerMode,
 * the default): it is checked against the token's `aud`/`azp`, so a token the issuer made for another app (same Google
 * account, same Auth0/Clerk tenant) is refused. Not required for:
 * - 'full' / 'admin': teenybase-to-teenybase tokens, whose `aud` holds the user's roles; the issuer's key is the trust;
 * - the supabase preset (hosted Supabase issuer), which supplies the audience ('authenticated').
 * An entry is an issuer when it has `issuer` or is the `google` preset (whose issuer is filled in); others are OAuth-only.
 */
function refineIssuerClientId(data: {name?: string, issuer?: string, clientId?: string | string[], bearerMode?: string}, ctx: z.RefinementCtx) {
    const isIssuer = !!data.issuer || data.name === 'google'
    if (!isIssuer || data.clientId !== undefined) return
    if (data.bearerMode === 'full' || data.bearerMode === 'admin') return
    if (data.issuer && SUPABASE_ISSUER_PATTERN.test(data.issuer)) return
    ctx.addIssue({
        code: 'custom',
        path: ['clientId'],
        message: `clientId is required for the JWT issuer ${data.issuer ?? data.name}: tokens are accepted only when their aud (or azp) is one of these client IDs, otherwise a token the issuer made for any other app would sign in here. Use your OAuth client ID (Google), API identifier (Auth0) or the aud your issuer puts in its tokens.`,
    })
}

/** JWK public key — requires kty, allows standard JWK fields */
const jwkSchema = z.object({
    kty: z.string(),
    // RSA fields
    n: z.string().optional(),
    e: z.string().optional(),
    // EC fields
    crv: z.string().optional(),
    x: z.string().optional(),
    y: z.string().optional(),
    // Common fields
    kid: z.string().optional(),
    alg: z.string().optional(),
    use: z.string().optional(),
    key_ops: z.array(z.string()).optional(),
}).passthrough() // allow additional fields from providers

export const issuerConfigSchema = z.object({
    issuer: z.string(),
    secret: z.union([z.string(), jwkSchema]).optional(),
    jwksUrl: z.url().optional(),
    algorithm: z.string().optional(),
    clientId: z.union([z.string(), z.array(z.string())]).optional(),
    trustEmailVerified: z.boolean().optional(),
    bearerMode: z.enum(['login', 'partial', 'full', 'admin']).optional(),
}).superRefine(refineIssuerClientId);

/** @deprecated jwtAllowedIssuers. The string form has no clientId, so it is accepted only for hosted Supabase issuers. */
export const allowedIssuerSchema = z.union([
    z.string().refine(iss => SUPABASE_ISSUER_PATTERN.test(iss), {
        message: 'A jwtAllowedIssuers string entry has no clientId: use authProviders: [{issuer, clientId, ...}] instead',
    }),
    issuerConfigSchema,
]);

const oauthMappingSchema = z.object({
    email: z.string().optional(),
    name: z.string().optional(),
    avatar: z.string().optional(),
    username: z.string().optional(),
    verified: z.string().optional(),
}).optional()

export const authProviderSchema = z.object({
    name: z.string().min(1).optional(),
    issuer: z.string().optional(),

    // OAuth redirect fields
    clientId: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
    clientSecret: z.string().min(1).optional(),
    scopes: z.array(z.string()).optional(),
    authorizeUrl: z.url().optional(),
    tokenUrl: z.url().optional(),
    userinfoUrl: z.url().optional(),
    redirectUrl: z.string().optional(),
    authorizeParams: z.record(z.string(), z.string()).optional(),
    userinfoHeaders: z.record(z.string(), z.string()).optional(),
    userinfoField: z.string().optional(),
    mapping: oauthMappingSchema,
    trustEmailVerified: z.boolean().optional(),

    // JWT/Bearer verification fields
    secret: z.union([z.string(), jwkSchema]).optional(),
    jwksUrl: z.url().optional(),
    algorithm: z.string().optional(),

    // Behavior
    bearerMode: z.enum(['login', 'partial', 'full', 'admin']).optional(),
}).superRefine((data, ctx) => {
    // clientSecret requires clientId and name (OAuth flow needs both)
    if (data.clientSecret) {
        if (!data.clientId) {
            ctx.addIssue({code: 'custom', message: 'clientId is required when clientSecret is provided', path: ['clientId']})
        }
        if (!data.name) {
            ctx.addIssue({code: 'custom', message: 'name is required when clientSecret is provided (used in OAuth route path)', path: ['name']})
        }
    }
    // At least one identifier must be provided
    if (!data.name && !data.issuer && !data.jwksUrl && !data.secret) {
        ctx.addIssue({code: 'custom', message: 'At least one of name, issuer, jwksUrl, or secret must be provided', path: []})
    }
    refineIssuerClientId(data, ctx)
});
