import {JWTPayload2} from './jwt'

export interface AuthContext{
    uid: string | null,
    cid?: string | null, // table/collection id
    email: string | null,
    jwt: Partial<JWTPayload2>
    verified: boolean
    role: string | string[] | null // jwt.aud
    meta: any | null // jwt.meta
    admin: boolean
}
