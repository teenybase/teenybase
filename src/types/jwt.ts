import {JwtPayload} from '@tsndr/cloudflare-worker-jwt'

export type JWTPayload = JwtPayload & {
    id: string
    sub: string
    user: string
    verified: boolean
    cid: string // table/collection name
    // rc?: number // refresh count
    meta?: Record<string, any> // custom metadata
    sid: string // session id, used for refresh
}
export type JWTPayload2 = JWTPayload & {
    iss: string
    iat: number
    exp: number
    admin?: boolean
    azp?: string // authorized party (like google client id)
}

export type JWTPayloadOp = Required<Pick<JWTPayload2, 'verified'|'sub'|'iss'>> & Partial<JWTPayload2>
