import {decode, JwtAlgorithm, sign, verify} from '@tsndr/cloudflare-worker-jwt'
import {JWTPayload, JWTPayload2, JWTPayloadOp} from '../types/jwt'
import {HTTPException} from 'hono/http-exception'
import {AllowedIssuer, IssuerConfig} from '../types/config'

export class JWTTokenHelper{
    private issuerMap: Map<string, IssuerConfig> = new Map()

    constructor(
        private secret: ()=>Promise<string>,
        readonly issuer: string = '$db',
        private algorithm: JwtAlgorithm|string = 'HS256',
        allowedIssuers?: AllowedIssuer[]) {
        // Add default issuer to map
        this.issuerMap.set(issuer, {
            algorithm: this.algorithm
        })

        if (allowedIssuers) {
            // Build issuer map for quick lookup
            allowedIssuers.forEach(issuer => {
                if (typeof issuer === 'object') {
                    this.issuerMap.set(issuer.issuer, {
                        secret: issuer.secret,
                        algorithm: issuer.algorithm,
                        clientId: issuer.clientId
                    })
                }else {
                    this.issuerMap.set(issuer, {} )
                }
            })
        }
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
        return sign(claims, await this.secret() + secret, {algorithm: this.algorithm, header: {typ: 'JWT'}})
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

        // Default JWT verification
        if (payload.iss !== this.issuer) throw new HTTPException(400, {message: 'Invalid issuer'})

        const valid = await verify(auth, await this.secret() + secret, {
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
        const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${auth}`)
        const json = await res.json().catch(_=>({})) as any
        // console.log(json)
        // todo use zod for validation
        if(!res.ok || !json || json.error || !json.email || !json.email_verified) throw new HTTPException(401, {message: 'Invalid google token, unable to find email'})
        if((payload as any).email !== json.email) throw new HTTPException(401, {message: 'Unknown error, Invalid email from google verification'})

        // Verify client ID (audience) if configured
        if (issuerConfig?.clientId !== undefined) {
            const aud = json.azp || (payload as any).azp || (payload as any).aud
            if (aud !== issuerConfig.clientId) throw new HTTPException(401, {message: 'Invalid Google OAuth client ID'})
        }

        // todo mark this token as "used" so it cannot be used again to login and create a new session.
        return {issData: payload, verified: true, sub: json.email, iss: 'google'} as JWTPayloadOp
    }

    private async verifySupabaseToken(auth: string, payload: JWTPayload2): Promise<JWTPayloadOp> {
        const issuerConfig = this.issuerMap.get(payload.iss)
        if (!issuerConfig || !issuerConfig.secret) throw new HTTPException(401, {message: 'Supabase issuer not configured'})

        const secret = issuerConfig.secret // Type narrowing
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

        // todo mark this token as "used" so it cannot be used again to login and create a new session.
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

    // Issuer patterns for different providers
    static GOOGLE_ISSUER_PATTERN = /^https:\/\/accounts\.google\.com$/
    static SUPABASE_ISSUER_PATTERN = /^https:\/\/[^\/]+\.supabase\.co\/auth\/v1$/

}
