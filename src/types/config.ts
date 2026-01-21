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
