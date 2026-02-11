import {AlterTable, TableData} from "./table";
import {BaseTemplateProps} from "./email";
import {MailgunBindings} from "./mailgun";
import {SQLProcedure} from './sql'
import {ResendBindings} from './resend'
import {JwtAlgorithm} from '@tsndr/cloudflare-worker-jwt'

export interface EmailSettings {
    from: string // default, in-case not provided in sendEmail
    variables: BaseTemplateProps

    tags?: string[] // used only in case of mailgun
    mailgun?: MailgunBindings
    resend?: ResendBindings
}

export interface AuthCookieConfig {
    name: string
    httpOnly?: boolean
    secure?: boolean
    sameSite?: 'Strict' | 'Lax' | 'None'
    path?: string
    maxAge?: number
    domain?: string
}

export interface OAuthProviderConfig {
    name: string              // provider key used in route path: 'google', 'github', etc.
    authorizeUrl?: string     // preset for known providers
    tokenUrl?: string         // preset for known providers
    userinfoUrl?: string      // required for opaque-token providers (GitHub, Discord)
    clientId: string          // literal or $ENV_VAR
    clientSecret: string      // $ENV_VAR
    scopes?: string[]         // preset defaults for known providers
    redirectUrl?: string      // frontend URL to redirect after auth, default appUrl
    mapping?: {               // map provider response fields to standard names
        email?: string        // default 'email'
        name?: string         // default 'name'
        avatar?: string
        username?: string
        verified?: string     // default 'email_verified'
    }
}

export interface DatabaseSettings {
    tables: TableData[]
    jwtSecret: string
    jwtIssuer?: string
    jwtAlgorithm?: JwtAlgorithm | string
    jwtAllowedIssuers?: AllowedIssuer[]

    appName?: string
    appUrl: string

    procedures?: SQLProcedure[]

    email?: EmailSettings

    authCookie?: AuthCookieConfig
    oauthProviders?: OAuthProviderConfig[]

    // this should not be changed manually
    version?: number // todo rename to _version

    _kvTableName?: string

    // todo implement below in backend
    disableTablesEdit?: boolean // disable/throw error creating and editing tables

    // for comments and notes
    ['//']?: string
}

export type AlterSettings = {create: TableData[], drop: TableData[], alter: AlterTable[]}

export type IssuerConfig = {
    secret?: string
    algorithm?: JwtAlgorithm | string
    clientId?: string
}

export type AllowedIssuer = string | ({ issuer: string } & IssuerConfig)
