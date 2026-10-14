import {z} from 'zod';

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
    bearerMode: z.enum(['login', 'partial', 'full', 'admin']).optional(),
});

export const allowedIssuerSchema = z.union([
    z.string(),
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
});
