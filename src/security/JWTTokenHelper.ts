import {decode, JwtAlgorithm, sign, verify} from '@tsndr/cloudflare-worker-jwt'
import {JWTPayload, JWTPayload2, JWTPayloadOp} from '../types/jwt'
import {HTTPException} from 'hono/http-exception'

export class JWTTokenHelper{
    allowedIssuers: string[] = []
    constructor(
        private secret: string,
        readonly issuer: string = '$db',
        private algorithm: JwtAlgorithm|string = 'HS256',
        allowedIssuers?: string[]) {
        this.allowedIssuers.push(issuer)
        if(allowedIssuers) this.allowedIssuers.push(...allowedIssuers)
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
        return sign(claims, this.secret + secret, {algorithm: this.algorithm, header: {typ: 'JWT'}})
    }

    async decodeAuth(auth: string, secret: string, /*hasOtp: boolean,*/ onlyVerified = true, issuers?: string[], payload?: JWTPayloadOp) {
        payload = payload || decode(auth).payload as JWTPayload2
        if (!this.allowedIssuers.includes(payload.iss)) throw new HTTPException(401, {message: 'Invalid app, ' + payload.iss})
        if(issuers && !issuers.includes(payload.iss)) throw new HTTPException(401, {message: 'Invalid issuer'})

        if(payload.iss.includes('accounts.google.com')){
            // google - https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=<access token>
            // or the proper way - https://developers.google.com/identity/gsi/web/guides/verify-google-id-token#using-a-google-api-client-library
            // ideally we should issue our own token from google's token and verify that easily.

            // doing first way. todo do it properly when we figure out public cert caching in cf workers, till then this is better
            const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${auth}`)
            const json = await res.json().catch(_=>({})) as any
            // console.log(json)
            const email = json.email
            if(!res.ok || json.error || !email || !json.email_verified) throw new HTTPException(401, {message: 'Invalid google token, unable to find email'})
            if((payload as any).email !== email) throw new HTTPException(401, {message: 'Unknown error, Invalid email from google verification'})
            return {issData: payload, verified: true, sub: email, iss: 'google'} as JWTPayloadOp
        }

        if (payload.iss !== this.issuer) throw new HTTPException(400, {message: 'Invalid issuer'})

        const valid = await verify(auth, this.secret + secret, {
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
}
