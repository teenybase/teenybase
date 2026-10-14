import {JwtPayload} from '@tsndr/cloudflare-worker-jwt'

/**
 * JWT payload for teenybase auth tokens.
 *
 * Claims are assembled in `tableAuthExtension._refreshSession()` from the user record.
 * Field usages map to claims: auth_email→sub, auth_username→user, auth_audience→aud,
 * auth_metadata→meta, auth_email_verified→verified.
 */
export type JWTPayload = JwtPayload & {
    /** User's unique record ID (from record_uid field) */
    id: string
    /** User's email address (from auth_email field) */
    sub: string
    /** User's username (from auth_username field). Note: claim is "user", not "username". */
    user: string
    /** Whether the user's email is verified (from auth_email_verified field) */
    verified: boolean
    /** Table/collection name this token was issued for (e.g. "users", "platform_users") */
    cid: string
    /** Custom metadata from auth_metadata field (JSON) */
    meta?: Record<string, any>
    /** Session ID — unique per login, used for refresh token validation and session revocation */
    sid: string
}
export type JWTPayload2 = JWTPayload & {
    iss: string
    iat: number
    exp: number
    /** Whether the user is an admin (set by admin service token auth, not by user JWT) */
    admin?: boolean
    /** Authorized party — e.g. Google client ID for OAuth tokens */
    azp?: string
}

export type JWTPayloadOp = Required<Pick<JWTPayload2, 'verified'|'sub'|'iss'>> & Partial<JWTPayload2>
