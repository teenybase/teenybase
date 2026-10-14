import {decode, JwtAlgorithm, sign, verify} from '@tsndr/cloudflare-worker-jwt'
import {JWTPayload, JWTPayload2, JWTPayloadOp} from '../types/jwt'
import {HTTPException} from 'hono/http-exception'
import {AuthProvider} from '../types/config'
import {SecretResolver} from '../worker/secretResolver'

/** Preset issuer and JWKS config for known providers.
 *  issuer: fixed string for providers with a single issuer (google), RegExp for project-specific issuers (supabase).
 *  jwksUrl: fixed string or function that derives URL from the issuer. */
const PROVIDER_JWT_PRESETS: Record<string, { issuer: string | RegExp, jwksUrl: string | ((issuer: string) => string) }> = {
    google: {
        issuer: 'https://accounts.google.com',
        jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    },
    supabase: {
        issuer: /^https:\/\/[^/]+\.supabase\.co\/auth\/v1$/,
        jwksUrl: (iss: string) => `${iss}/.well-known/jwks.json`,
    },
    // todo: add auth0, firebase, clerk presets
}

export class JWTTokenHelper{
    private issuerMap: Map<string, AuthProvider> = new Map()

    /** JWKS cache — static so it survives across requests within the same worker isolate.
     *  JWTTokenHelper is created per-request (via $Database), but JWKS keys rotate rarely,
     *  so caching at isolate level avoids redundant fetches on every request. */
    private static jwksCache: Map<string, { keys: JsonWebKeyWithKid[], fetchedAt: number }> = new Map()
    private static readonly JWKS_CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

    constructor(
        private secret: string,
        readonly issuer: string = '$db',
        private algorithm: JwtAlgorithm|string = 'HS256',
        authProviders?: AuthProvider[],
        private secretResolver?: SecretResolver) {
        // Add default issuer to map
        this.issuerMap.set(issuer, {
            algorithm: this.algorithm
        })

        if (authProviders) {
            for (const provider of authProviders) {
                // Resolve issuer from preset if only name is provided
                const resolvedIssuer = provider.issuer ?? this.resolvePresetIssuer(provider.name)
                if (!resolvedIssuer) continue // No issuer and no matching preset — OAuth-only provider, skip JWT setup

                // Auto-fill jwksUrl from preset if not explicitly provided and no secret configured
                const resolvedProvider = { ...provider, issuer: resolvedIssuer }
                if (!resolvedProvider.jwksUrl && !resolvedProvider.secret) {
                    resolvedProvider.jwksUrl = this.resolvePresetJwksUrl(provider.name, resolvedIssuer)
                }

                const existing = this.issuerMap.get(resolvedIssuer)
                if (existing && provider.clientId) {
                    // Merge clientIds into an array (e.g. multiple Google clientIds for ios/web/android)
                    const existingIds = existing.clientId ? (Array.isArray(existing.clientId) ? existing.clientId : [existing.clientId]) : []
                    const newIds = Array.isArray(provider.clientId) ? provider.clientId : [provider.clientId]
                    existing.clientId = [...existingIds, ...newIds]
                } else {
                    this.issuerMap.set(resolvedIssuer, resolvedProvider)
                }
            }
        }
    }

    /** Resolve issuer URL from provider name preset.
     *  Only works for fixed-string issuers (e.g., google). Pattern-based presets (e.g., supabase)
     *  need an explicit issuer from the user since they're project-specific. */
    private resolvePresetIssuer(name?: string): string | undefined {
        if (!name) return undefined
        const preset = PROVIDER_JWT_PRESETS[name]
        if (!preset || typeof preset.issuer !== 'string') return undefined
        return preset.issuer
    }

    /** Resolve JWKS URL from provider name or issuer pattern */
    private resolvePresetJwksUrl(name?: string, issuer?: string): string | undefined {
        // Try by name first
        if (name) {
            const preset = PROVIDER_JWT_PRESETS[name]
            if (preset) {
                return typeof preset.jwksUrl === 'string' ? preset.jwksUrl : issuer ? preset.jwksUrl(issuer) : undefined
            }
        }
        // Try by issuer pattern (for providers configured with explicit issuer but no name)
        if (issuer) {
            for (const preset of Object.values(PROVIDER_JWT_PRESETS)) {
                if (preset.issuer instanceof RegExp && preset.issuer.test(issuer)) {
                    return typeof preset.jwksUrl === 'string' ? preset.jwksUrl : preset.jwksUrl(issuer)
                }
            }
        }
        return undefined
    }

    /** Get the bearerMode for an issuer. Returns 'admin' for self-issued, 'login' (default) for all external. */
    getBearerMode(iss: string): 'login' | 'partial' | 'full' | 'admin' {
        if (iss === this.issuer) return 'admin'
        return this.issuerMap.get(iss)?.bearerMode || 'login'
    }

    /** Resolve a config value (string or $ENV_VAR) via secretResolver, falling back to raw value */
    private async resolveValue(value: string | undefined): Promise<string> {
        if (!value) return ''
        if (this.secretResolver) return this.secretResolver.resolve(value)
        return value
    }


    async createJwtToken<T = JWTPayload>(payload: T & {id: string, sub: string}, secret: string, secondsDuration: number): Promise<string> {
        const time = Math.floor(Date.now() / 1000)
        const claims = {
            ...payload,
            iat: time,
            exp: time + secondsDuration,
            // admin: false,
            iss: this.issuer,
        }
        // todo: use HMAC-based key derivation (e.g. HKDF) instead of string concatenation to combine secrets?
        return sign(claims, await this.resolveValue(this.secret) + secret, {algorithm: this.algorithm, header: {typ: 'JWT'}})
    }

    async decodeAuth(auth: string, secret: string, /*hasOtp: boolean,*/ onlyVerified = true, issuers?: string[], payload?: JWTPayloadOp) {
        payload = payload || decode(auth).payload as JWTPayload2
        if (!this.issuerMap.has(payload.iss)) throw new HTTPException(401, {message: 'Invalid app, ' + payload.iss})
        if(issuers && !issuers.includes(payload.iss)) throw new HTTPException(401, {message: 'Invalid issuer'})

        // Google OAuth verification
        if (JWTTokenHelper.GOOGLE_ISSUER_PATTERN.test(payload.iss)) {
            return await this.verifyGoogleToken(auth, payload as any)
        }

        // Supabase JWT verification
        if (JWTTokenHelper.SUPABASE_ISSUER_PATTERN.test(payload.iss)) {
            return await this.verifySupabaseToken(auth, payload as any)
        }

        // Custom external issuer verification (e.g. cross-instance auth, Auth0, Firebase)
        if (payload.iss !== this.issuer) {
            return await this.verifyExternalToken(auth, payload as any)
        }

        // Self-issued JWT verification (uses double-secret: global + table-level)
        if (!secret?.length) throw new HTTPException(401, {message: 'Unauthorized - invalid token'})
        const valid = await verify(auth, await this.resolveValue(this.secret) + secret, {
            throwError: false,
            algorithm: this.algorithm,
        })
        // todo if the token is expired, dont throw error, instead ignore it for resend etc?
        if (!valid) throw new HTTPException(401, {message: 'Unauthorized - invalid token'})

        const email = payload.sub

        // let otp = undefined
        if (!payload.verified) {
            if (onlyVerified) throw new HTTPException(403, {message: 'Not verified'})

            // const otpEncrypted = payload.key
            // if(!otpEncrypted) throw new HTTPException(400, {message: 'Invalid token'})
            // otp = await aesGcmDecrypt(atob(otpEncrypted), email + secret)
            // if (!hasOtp) if (!payload.iat || (Date.now() / 1000) - payload.iat < globalConfig.OTP_EMAIL_RESEND_THRESH)
            // 	throw new HTTPException(400, {message: 'Too soon to resend'})
        }

        // return {
        // 	verified: payload.verified || false, email,
        // 	// otp,
        // 	issuer: payload.iss,
        // 	payload,
        // }
        return payload
    }

    private async verifyGoogleToken(auth: string, payload: JWTPayload2): Promise<JWTPayloadOp> {
        // todo add client id check in the config. also how long is the google token valid?
        // if(payload.azp !== globalConfig.AUTH_GOOGLE_OAUTH_CLIENT_ID) throw new HTTPException(400, {message: 'Invalid google token, unauthorized app'})

        // google - https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=<access token>
        // or the proper way - https://developers.google.com/identity/gsi/web/guides/verify-google-id-token#using-a-google-api-client-library
        // ideally we should issue our own token from google's token and verify that easily.

        const issuerConfig = this.issuerMap.get(payload.iss)

        // doing first way. todo do it properly in DO or when we figure out public cert caching in cf workers, till then this is better
        // todo use this instead https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
        const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${auth}`)
        const json = await res.json().catch(_=>({})) as any
        // console.log(json)
        // todo use zod for validation
        if(!res.ok || !json || json.error || !json.email || !json.email_verified) throw new HTTPException(401, {message: 'Invalid google token, unable to find email'})
        if((payload as any).email !== json.email) throw new HTTPException(401, {message: 'Unknown error, Invalid email from google verification'})

        // Verify client ID (audience) if configured
        if (issuerConfig?.clientId !== undefined) {
            const aud = json.azp || (payload as any).azp || (payload as any).aud
            const rawIds = Array.isArray(issuerConfig.clientId) ? issuerConfig.clientId : [issuerConfig.clientId]
            const allowedIds = await Promise.all(rawIds.map(id => this.resolveValue(id)))
            if (!allowedIds.includes(aud)) throw new HTTPException(401, {message: 'Invalid Google OAuth client ID'})
        }

        // todo: mark this token as "used" (e.g. store token hash in KV with TTL) so it cannot be replayed to create multiple sessions
        return {issData: payload, verified: true, sub: json.email, iss: 'google'} as JWTPayloadOp
    }

    private async verifySupabaseToken(auth: string, payload: JWTPayload2): Promise<JWTPayloadOp> {
        const issuerConfig = this.issuerMap.get(payload.iss)
        if (!issuerConfig || !issuerConfig.secret || typeof issuerConfig.secret !== 'string') throw new HTTPException(401, {message: 'Supabase issuer not configured'})

        const secret = await this.resolveValue(issuerConfig.secret)
        if (!secret) throw new HTTPException(401, {message: 'Supabase issuer secret not available'})
        const valid = await verify(auth, secret, {
            throwError: false,
            algorithm: issuerConfig.algorithm || 'HS256',
        })

        if (!valid) throw new HTTPException(401, {message: 'Invalid supabase token'})

        const payloadAny = payload as any
        const email = payloadAny.email || payloadAny.user_metadata?.email
        const emailVerified = payloadAny.user_metadata?.email_verified ?? false // todo this is always false?
        const fullName = payloadAny.user_metadata?.full_name || ''
        const userName = payloadAny.user_metadata?.username || ''
        const userId = payloadAny.sub || email

        if (!email) throw new HTTPException(401, {message: 'Invalid supabase token, unable to find email'})

        // todo: mark this token as "used" (e.g. store token hash in KV with TTL) so it cannot be replayed to create multiple sessions
        return {
            issData: {
                name: fullName,
                username: userName,
                ...payload
            },
            // todo email_verified is false, maybe we can check for payload.amr
            // verified: emailVerified,
            verified: true,
            sub: email, iss: payload.iss
        } as JWTPayloadOp
    }

    /**
     * Verify a JWT from a custom external issuer configured in authProviders.
     * Key source types:
     *   - secret (string)  — HMAC shared secret or PEM public key string
     *   - secret (object)  — JWK public key object (e.g. { kty: "RSA", n: "...", e: "AQAB" })
     *   - jwksUrl (string) — JWKS endpoint URL, keys are fetched and cached, matched by kid header
     * Uses the issuer's own key (not concatenated with the global secret).
     * Supports audience (clientId) validation when configured.
     */
    private async verifyExternalToken(auth: string, payload: JWTPayload2): Promise<JWTPayloadOp> {
        const issuerConfig = this.issuerMap.get(payload.iss)
        if (!issuerConfig) {
            throw new HTTPException(401, {message: 'External issuer not configured'})
        }

        const { key: verifyKey, algorithm: resolvedAlg } = await this.resolveExternalKey(auth, issuerConfig)
        // Algorithm resolution priority: explicit config > JWK alg field > default based on key type
        const algorithm = issuerConfig.algorithm || resolvedAlg || (typeof verifyKey === 'string' ? 'HS256' : 'RS256')

        const valid = await verify(auth, verifyKey, {
            throwError: false,
            algorithm,
        })
        if (!valid) throw new HTTPException(401, {message: 'Invalid external token'})

        // Audience/clientId validation (same pattern as Google handler)
        if (issuerConfig.clientId !== undefined) {
            const aud = (payload as any).aud || (payload as any).azp
            const audList = Array.isArray(aud) ? aud : [aud]
            const rawIds = Array.isArray(issuerConfig.clientId) ? issuerConfig.clientId : [issuerConfig.clientId]
            const allowedIds = await Promise.all(rawIds.map(id => this.resolveValue(id)))
            if (!audList.some(a => allowedIds.includes(a))) {
                throw new HTTPException(401, {message: 'Invalid audience for external issuer'})
            }
        }

        // Extract email — support common claim locations across providers
        const p = payload as any
        const email = p.email || p.sub || p.user_metadata?.email
        if (!email) throw new HTTPException(401, {message: 'External token missing identity claim (email or sub)'})

        const verified = p.email_verified ?? p.verified ?? true
        const mode = issuerConfig.bearerMode || 'login'

        // 'partial' / 'login': identity fields only
        if (mode === 'login' || mode === 'partial') {
            return { issData: payload, verified, sub: email, iss: payload.iss } as JWTPayloadOp
        }

        // 'full': identity + session/user fields (no admin)
        // 'admin': identity + session/user fields + admin flag
        return {
            issData: payload,
            verified,
            sub: email,
            iss: payload.iss,
            id: p.id,
            cid: p.cid,
            sid: p.sid,
            meta: p.meta,
            aud: p.aud,
            iat: p.iat,
            exp: p.exp,
            ...(mode === 'admin' ? { admin: p.admin } : {}),
        } as JWTPayloadOp
    }

    /**
     * Resolve the verification key for an external issuer.
     * Priority: secret (string or JWK) > jwksUrl (remote JWKS)
     *
     * For JWK keys (object secret or jwksUrl), returns the JWK directly — the verify library
     * handles import to CryptoKey internally via its own importKey/importJwk pipeline.
     * For strings (HMAC secret or PEM), returns as-is.
     * Returns both the key and the algorithm extracted from the JWK (if available).
     */
    private async resolveExternalKey(token: string, config: AuthProvider): Promise<{ key: string | JsonWebKeyWithKid, algorithm?: string }> {
        // 1. Secret — string (HMAC/PEM) or JWK object
        if (config.secret) {
            if (typeof config.secret === 'object') {
                // JWK public key object — pass directly to verify(), which imports internally.
                // Spread with kid fallback: JsonWebKeyWithKid requires kid: string, but inline
                // JWK configs may omit it. Empty string is harmless — WebCrypto ignores kid on import.
                const alg = config.secret.alg as string | undefined
                return { key: { kid: '', ...config.secret }, algorithm: alg }
            }
            // HMAC secret or PEM public key string
            const resolved = await this.resolveValue(config.secret)
            if (!resolved) throw new HTTPException(401, {message: 'External issuer secret not available'})
            return { key: resolved }
        }

        // 2. JWKS URL — fetch, cache, match by kid, return JWK directly
        if (config.jwksUrl) {
            const jwk = await this.resolveJwksKey(token, config.jwksUrl)
            const alg = jwk.alg as string | undefined
            return { key: jwk, algorithm: alg }
        }

        throw new HTTPException(401, {message: 'External issuer not properly configured (missing secret or jwksUrl)'})
    }

    /**
     * Fetch JWKS from a URL (with in-memory cache), then find the key matching the token's kid header.
     * If no kid in token header, uses the first key in the set.
     */
    private async resolveJwksKey(token: string, jwksUrl: string): Promise<JsonWebKeyWithKid> {
        const now = Date.now()
        let cached = JWTTokenHelper.jwksCache.get(jwksUrl)

        if (!cached || (now - cached.fetchedAt) > JWTTokenHelper.JWKS_CACHE_TTL_MS) {
            const res = await fetch(jwksUrl)
            if (!res.ok) throw new HTTPException(502, {message: `Failed to fetch JWKS from ${jwksUrl}`})
            // JWKS keys are required to have kid per RFC 7517 §4.5 (when used in a JWK Set)
            const json = await res.json().catch(() => null) as { keys?: JsonWebKeyWithKid[] } | null
            if (!json?.keys?.length) throw new HTTPException(502, {message: 'JWKS response missing keys array'})
            cached = { keys: json.keys, fetchedAt: now }
            JWTTokenHelper.jwksCache.set(jwksUrl, cached)
        }

        // Extract kid from token header
        const header = decode(token).header as { kid?: string } | null
        const kid = header?.kid

        let key: JsonWebKeyWithKid | undefined
        if (kid) {
            key = cached.keys.find(k => k.kid === kid)
            if (!key) {
                // kid not found in cache — force re-fetch once in case keys were rotated
                if ((now - cached.fetchedAt) > 1000) { // don't re-fetch if we just fetched
                    JWTTokenHelper.jwksCache.delete(jwksUrl)
                    return this.resolveJwksKey(token, jwksUrl)
                }
                throw new HTTPException(401, {message: `No matching key found in JWKS for kid '${kid}'`})
            }
        } else {
            // No kid in token header — use the first key
            key = cached.keys[0]
        }

        return key
    }

    // Issuer patterns for different providers
    static GOOGLE_ISSUER_PATTERN = /^https:\/\/accounts\.google\.com$/
    static SUPABASE_ISSUER_PATTERN = /^https:\/\/[^\/]+\.supabase\.co\/auth\/v1$/

}
