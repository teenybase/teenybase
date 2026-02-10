import {z, ZodError} from 'zod'
import {TableExtension} from '../tableExtension'
import {TableAuthExtensionData} from '../../types/tableExtensions'
import {HTTPException} from 'hono/http-exception'
import {$Table} from '../$Table'
import {ident, JsepContext} from '../../sql/parse/jsep'
import {InsertQuery} from '../../sql/build/insert'
import {literalToQuery} from '../../sql/build/query'
import {UpdateQuery} from '../../sql/build/update'
import {DeleteQuery} from '../../sql/build/delete'
import {appendWhere, SelectQuery} from '../../sql/build/select'
import {recordToSqlValues} from '../../sql/parse/parse'
import {JWTPayload, JWTPayload2} from '../../types/jwt'
import {generateUid, randomString} from '../../security/random'
import {InsertParams, SQLLiteral, SQLQuery} from '../../types/sql'
import {passwordProcessors} from '../util/passwordProcessors'
import {Context} from 'hono'
import {normalizeEmail} from '../util/normalizeEmail'
import {sqlValSchema} from '../../types/zod/sqlSchemas'
import {tableAuthDataSchema} from '../../types/zod/tableExtensionsSchema'
import {decode} from '@tsndr/cloudflare-worker-jwt'
import {defaultSchema, jwtTokenSchema, uidTokenSchema} from './tableAuthExtension.schema'
import {setupTableAuthExtensionRoutes} from './tableAuthExtension.routes'
import {D1Error} from '../util/error'
import {zParseWithPath} from '../../utils/zod'

type UserFields = {
    emailVerified?: boolean
    id: string
    email?: string
    username?: string
    audience?: string[] // roles
    metadata?: string
    // password?: string
    // passwordSalt?: string
}

type UserFieldsAdmin = UserFields & {
    password?: string
    passwordSalt?: string
}

const SALT_LENGTH = 20

export class TableAuthExtension extends TableExtension<TableAuthExtensionData> {
    static readonly name = 'auth'

    readonly mapping
    private jwtSecret: ()=>Promise<string>

    // todo remove c from here
    constructor(data: TableAuthExtensionData, table: $Table, jc: JsepContext, private c: Context) {
        super(tableAuthDataSchema.parse(data), table, jc)
        if (data.name !== TableAuthExtension.name) throw new HTTPException(500, {message: 'Invalid Configuration'})
        if(!this.table.mapping.uid) throw new HTTPException(500, {message: 'Invalid Configuration - id field required'})
        this.jwtSecret = this.table.$db.secretResolver.resolver(this.data.jwtSecret, true, `JWT_SECRET for ${data.name}`)
        const aud = this.table.fieldsUsage.auth_audience
        this.mapping = {
            uid: this.table.mapping.uid,
            username: z.string().optional().parse(this.table.fieldsUsage.auth_username),
            email: z.string().optional().parse(this.table.fieldsUsage.auth_email),
            emailVerified: z.string().optional().parse(this.table.fieldsUsage.auth_email_verified),
            password: z.string().optional().parse(this.table.fieldsUsage.auth_password),
            passwordSalt: z.string().optional().parse(this.table.fieldsUsage.auth_password_salt),
            name: z.string().optional().parse(this.table.fieldsUsage.auth_name),
            avatar: z.string().optional().parse(this.table.fieldsUsage.auth_avatar),
            audience: (aud && !Array.isArray(aud)) ? [z.string().parse(aud)] : aud as string[] | undefined,
            metadata: z.string().optional().parse(this.table.fieldsUsage.auth_metadata),
            // resetSentAt: z.string().optional().parse(this.table.fieldsUsage.auth_reset_sent_at),
            // verificationSentAt: z.string().optional().parse(this.table.fieldsUsage.auth_verification_sent_at),
        } as const
        if(this.mapping.emailVerified && !this.mapping.email) throw new HTTPException(500, {message: 'Invalid Configuration - email field required for emailVerified'})
        if(this.mapping.passwordSalt && !this.mapping.password) throw new HTTPException(500, {message: 'Invalid Configuration - passwordSalt field required for password'})

        setupTableAuthExtensionRoutes.call(this)
    }

    async onInsertParse(query: InsertQuery) {
        const v = query.values
        const records = Array.isArray(v) ? v : [v]

        for (const record of records) {
            await this._parsePasswordFieldsInsert(record)

            this._parseUsername(record)

            if (this.mapping.email) this._parseEmail(record)
            if (this.mapping.name) zParseWithPath(defaultSchema.name, (record[this.mapping.name] as SQLLiteral)?.l, [this.mapping.name])

            if (this.mapping.emailVerified) {
                let val = zParseWithPath(defaultSchema.emailVerified, (record[this.mapping.emailVerified] as SQLLiteral)?.l, [this.mapping.emailVerified])

                if(!this.jc.globals.auth?.admin) {
                    if (val !== undefined) throw new HTTPException(400, {message: `${this.mapping.emailVerified} must not be set`})
                    record[this.mapping.emailVerified] = {l: false}
                }
            }
        }

        // todo send verification email after insert?
    }

    async onUpdateParse(query: UpdateQuery) {
        const record = query.set
        await this._parsePasswordFieldUpdate(record as any, query)
    }

    async onDeleteParse(query: DeleteQuery, admin?: boolean) {
        // todo
        if(!admin) throw new HTTPException(400, {message: `Not allowed`})
    }

    async onSelectParse(query: SelectQuery) {
        // do nothing
    }

    async onViewParse(query: SelectQuery) {
        return this.onSelectParse(query)
    }

    // why is this required? because this returns a token...
    async signUp(data: Required<InsertParams>['values']){
        if(!this.mapping.username || !this.mapping.password) throw new HTTPException(500, {message: 'Invalid Configuration'})

        const user = await this._createUser(data)

        const ret: {
            token: string,
            refresh_token: string,
            record: Record<string, z.infer<typeof sqlValSchema>>,
            verified?: boolean,
        } = {
            ...await this.createSession(user),
            record: this._userToFields(user),
        }
        if(this.mapping.emailVerified) {
            ret.verified = user.emailVerified
            if(!user.emailVerified && this.data.autoSendVerificationEmail){
                this.c.executionCtx.waitUntil(this._requestVerification(user))
            }
        }

        return ret
    }

    async requestVerification(){
        if(!this.mapping.email || !this.mapping.emailVerified) throw new HTTPException(500, {message: 'Invalid Configuration'})
        const auth = this.jc.globals.auth
        if(!auth?.uid) throw new HTTPException(403, {message: 'Unauthorized'})
        if(auth.verified) throw new HTTPException(400, {message: 'Already verified'})

        const user = await this.getUser(auth.uid)
        if(!user) throw new HTTPException(400, {message: 'User not found'})

        await this._requestVerification(user)
        return this.c.json({success: true})
    }

    confirmRequiresAuth = false // todo make setting
    async confirmVerification(){
        const data = await this.table.$db.getRequestBody()
        if (!data) throw new HTTPException(400, {message: 'Usage: POST /auth/confirm-verification {data} in JSON/FormData'})
        // console.log(data.token)
        const token = uidTokenSchema.parse(data.token)
        if(!token) throw new HTTPException(400, {message: 'Token required'})

        const auth = this.jc.globals.auth
        if(this.confirmRequiresAuth && (!auth || !auth.uid || !auth.sid)) throw new HTTPException(403, {message: 'Unauthorized'})
        const uid = this.confirmRequiresAuth ? auth!.uid! : undefined

        const user = await this._confirmVerification(token, uid)
        const ret: {
            token?: string,
            refresh_token?: string,
            record: Record<string, z.infer<typeof sqlValSchema>>,
        } = {
            ...(!auth?.sid && await this.createSession(user)),
            record: this._userToFields(user),
        }
        return this.c.json(ret)
    }

    async requestPasswordReset(){
        if(!this.mapping.email || !this.mapping.password) throw new HTTPException(500, {message: 'Invalid Configuration'})

        const data = await this.table.$db.getRequestBody()
        if(!data) throw new HTTPException(400, {message: 'Usage: POST /auth/request-password-reset {data} in JSON/FormData'})

        const record = recordToSqlValues(data)
        const email = this._parseEmail(record)

        const user = await this.findUser(email, true)
        if(!user) throw new HTTPException(400, {message: 'User not found'})
        const auth = this.jc.globals.auth
        // auth is optional here. todo make this configurable
        if(auth?.uid && (auth.uid !== user.id || auth.email !== email)) throw new HTTPException(403, {message: 'Unauthorized'})

        await this._requestPasswordReset(user)

        return this.c.json({success: true})
    }

    async confirmPasswordReset(){
        if(!this.mapping.email || !this.mapping.password) throw new HTTPException(500, {message: 'Invalid Configuration'})
        const data = await this.table.$db.getRequestBody()
        if (!data) throw new HTTPException(400, {message: 'Usage: POST /auth/confirm-password-reset {data} in JSON/FormData'})
        const token = uidTokenSchema.parse(data.token)
        if(!token) throw new HTTPException(400, {message: 'Token required'})
        delete data.token

        const record = recordToSqlValues(data)
        const password = await this._parsePasswordFieldsInsert(record)
        if(!password) throw new HTTPException(400, {message: 'Invalid password'})

        const user = await this._confirmPasswordReset(token, record)
        const ret = {
            ...await this.createSession(user),
            record: this._userToFields(user),
        } as {
            token: string,
            refresh_token: string,
            record: Record<string, z.infer<typeof sqlValSchema>>,
        }
        return this.c.json(ret)
    }

    async loginWithPassword(data?: Record<string, z.infer<typeof sqlValSchema>>){
        if(!this.mapping.password) throw new HTTPException(500, {message: 'Invalid Configuration'})

        if (!data) throw new HTTPException(400, {message: 'Usage: POST /auth/login-password {data} in JSON'})

        const record = recordToSqlValues(data)
        const username = (this.mapping.email && record[this.mapping.email]) ? this._parseEmail(record) :
            record['identity'] ? zParseWithPath(defaultSchema.identity, record['identity'].l, ["identity"]) :
            this._parseUsername(record)

        const invalid = async()=>{
            await new Promise((r)=>setTimeout(r, Math.random()*200)) // todo
            return new HTTPException(400, {message: 'Invalid username or password'})
        }
        const user = username ? await this.findUser(username, false, true) : null

        if(!user) throw await invalid()

        const salt = user.passwordSalt || ''

        const password = await this._parsePasswordFieldsLogin(record as any, salt).catch(e=>{
            console.error(e)
            return null
        })
        // console.log(password, res)
        if(!password || password !== user.password) throw await invalid()

        // todo
        // if(this.mapping.emailVerified && !user.emailVerified) throw new HTTPException(400, {message: 'Email not verified'})

        const ret: {
            token: string,
            record: Record<string, z.infer<typeof sqlValSchema>>,
            refresh_token: string,
            verified?: false
        } = {
            ...await this.createSession(user),
            record: this._userToFields(user),
        }
        if(this.mapping.emailVerified && !user.emailVerified) ret.verified = false
        // return this.c.json(ret)
        return ret
    }

    /**
     * validates token from google, github etc or self(disabled for now) and creates a new session
     */
    async loginWithToken(){
        const tok = this.c.req.header('Authorization')?.replace(/^Bearer /, '')
        if (!tok) throw new HTTPException(400, {message: 'Authorization header required'})
        const payload = await this.table.$db.jwt.decodeAuth(tok, await this.jwtSecret(), false).catch(() => null)
        // payload will be null when sign not valid or expired etc
        if (!payload) throw new HTTPException(401, {message: 'Unauthorized'})

        let res = await this.findUser(payload.sub, true)

        if(payload.iss !== this.table.$db.jwt.issuer){
            // todo why this false and 0 check? because it can be 'true'?
            if(payload.verified === false || (payload as any).verified === 0) throw new HTTPException(400, {message: 'Not verified'})
            // todo make a setting in this.data to control whether a new user should be created on new token or should it be explicit
            if(!res) res = await this._createUserToken(payload.sub, true, payload?.issData)
        }else {
            // do nothing
            // todo throw error or refresh session?
            throw new HTTPException(400, {message: 'Use refresh-token endpoint instead'})
        }

        if(!res) throw new HTTPException(401, {message: 'Unauthorized'})

        // if(this.mapping.emailVerified && !res.emailVerified) throw new HTTPException(400, {message: 'Email not verified'})
        if(res.email !== payload.sub) throw new HTTPException(400, {message: 'Invalid email'})

        const ret: {
            token: string,
            refresh_token: string,
            record: Record<string, z.infer<typeof sqlValSchema>>,
            verified?: boolean,
        } = {
            ...await this.createSession(res),
            record: this._userToFields(res),
        }
        if(this.mapping.emailVerified && !res.emailVerified) ret.verified = false

        return ret
    }

    async refreshToken(data: {refresh_token: string}) {
        const tok = this.c.req.header('Authorization')?.replace(/^Bearer /, '')
        if (!tok) throw new HTTPException(400, {message: 'Authorization header required'})
        // todo not really required but can we verify the signature without verifying exp
        const payloadUntrusted = decode(tok).payload as JWTPayload2
        if(payloadUntrusted.iss !== this.table.$db.jwt.issuer || !payloadUntrusted.sub || !payloadUntrusted.sid) throw new HTTPException(401, {message: 'Invalid token'})
        const {sub, sid} = payloadUntrusted

        const refreshToken = uidTokenSchema.parse(data.refresh_token)
        const sessionId = z.string().min(10).parse(sid) // todo zod

        let res = await this.findUser(sub, true)
        if(!res) throw new HTTPException(401, {message: 'Unauthorized'})

        // if(this.mapping.emailVerified && !res.emailVerified) throw new HTTPException(400, {message: 'Email not verified'})
        if(res.email !== sub) throw new HTTPException(400, {message: 'Invalid email'})

        const token = await this.refreshSession(res, sessionId, refreshToken)

        const ret: {
            token: string,
            refresh_token: string,
            record: Record<string, z.infer<typeof sqlValSchema>>,
            verified?: boolean,
        } = {
            ...token,
            record: this._userToFields(res),
        }
        if(this.mapping.emailVerified && !res.emailVerified) ret.verified = false

        return ret
    }

    async changePassword(){
        if(!this.data.passwordType) throw new HTTPException(500, {message: 'Invalid Configuration'})

        const email = this.jc.globals.auth?.email
        if(!this.jc.globals.auth?.uid || !email) throw new HTTPException(401, {message: 'Unauthorized'})
        const data = await this.c.req.json()
        if (!data) throw new HTTPException(400, {message: 'Usage: POST /auth/change-password {data} in JSON'})

        const record = recordToSqlValues(data)
        const res = await this.findUser(email, false, true)
        if(!res) throw new HTTPException(400, {message: 'Invalid user'})

        const salt = res.passwordSalt || ''

        if(this.data.passwordCurrentSuffix) {
            let current = await this._parseCurrentPasswordField(record, salt)
            if(current !== res.password) throw new HTTPException(400, {message: 'Invalid current password'})
        }

        const password = await this._parsePasswordFieldsInsert(record)
        if(!password) throw new HTTPException(400, {message: 'Invalid password'})

        const res2 = await this.updateUser(res.id, record)
        if(!res2 || res2.id !== res.id) throw new HTTPException(500, {message: 'Failed to update password'})

        // Invalidate all sessions after password change for security
        const _token = await this._invalidateAllUserSessions(res.id) // return token

        return this.c.json({success: true})
    }

    async logout(){
        const auth = this.jc.globals.auth
        if(!auth?.uid || !auth?.sid) throw new HTTPException(401, {message: 'Unauthorized'})

        // const user = await this.getUser(auth.uid)
        // if(!user) throw new HTTPException(400, {message: 'User not found'})

        const sessionKey = this._kvSessionKey(/*user*/{id: auth.uid}, auth.sid)
        await this.table.$db.kv.remove(sessionKey)

        return this.c.json({success: true})
    }
    // todo
    // login with token
    // reset/forgot password
    // username change
    // username recovery

    // no point of this for this frontend, just use normal token. auth0 also says no point - https://auth0.com/blog/refresh-tokens-what-are-they-and-when-to-use-them/
    // actually useful to update meta and stuff
    // refresh token

    private async _refreshSession(res: UserFieldsAdmin, session: LoginSession) {
        const data = {
            cid: this.table.data.name,
            user: res.username, // todo: should this be added?
            sub: res.email,
            id: res.id,
            meta: res.metadata,
            sid: session.id, // session id
            // admin: false,
        } as JWTPayload
        if(res.audience && res.audience.length) data.aud = res.audience
        if(res.emailVerified !== undefined) data.verified = res.emailVerified

        const now = this.getTimestamp()
        const refreshToken = generateUid()
        session.tok = refreshToken
        session.rc++
        session.rat = now // Update refreshed at timestamp

        // todo parameter
        const refreshTokenDuration = /*this.data.refreshTokenDuration || */60 * 60 * 24 * 7 // default to 7 days
        const sessionDuration = /*this.data.sessionDuration || */60 * 60 * 24 * 30 // default to 30 days

        // Implement sliding expiration - extend session exp on each refresh
        session.exp = now + sessionDuration

        const sessionKey = this._kvSessionKey(res, session.id)

        // todo limit number of sessions - check how many sessions in table for the user, if more than allowed, deleted the first one
        // overwrite existing session
        await this.table.$db.kv.setMultiple({
            [sessionKey]: JSON.stringify(session),
        }, refreshTokenDuration)

        const token = await this.table.$db.jwt.createJwtToken(data, await this.jwtSecret(), this.data.jwtTokenDuration)

        return {
            token,
            refresh_token: refreshToken,
        }
    }

    private getTimestamp(){
        return Math.floor(Date.now() / 1000) // seconds since epoch
    }

    private async createSession(user: UserFieldsAdmin) {
        // save session and refresh token in the database
        const now = this.getTimestamp()
        const session: LoginSession = {
            id: generateUid(),
            tok: '', // refresh token
            cid: this.table.name,
            uid: user.id,
            sub: user.email,
            rc: 0, // refresh count
            cat: now, // created at
            rat: now, // refreshed at
            exp: now, // expires at (updated in refresh)
            // todo ip etc
        }
        return await this._refreshSession(user, session)
    }

    private async refreshSession(user: UserFieldsAdmin, id: string, token: string) {
        // save session and refresh token in the database
        const sessionKey = this._kvSessionKey(user, id)
        const sessionStr = await this.table.$db.kv.get<string>(sessionKey)

        const now = this.getTimestamp()

        // Parse the JSON string to get the session object
        let session: LoginSession | null = null
        if (sessionStr) {
            try {
                session = JSON.parse(sessionStr)
            } catch (e) {
                console.error(e)
            }
        }

        const isValid = !!session
            && session.tok === token
            && session.uid === user.id
            && (!this.data.maxTokenRefresh || session.rc < this.data.maxTokenRefresh)
            && (session.exp === undefined || session.exp > now)

        if(!isValid || !session) throw new HTTPException(401, {message: 'Invalid session'})

        return await this._refreshSession(user, session)
    }

    /**
     * @param loginId - username or email
     * @param emailOnly
     * @param asAdmin -
     * @private
     */
    private async findUser(loginId: string, emailOnly?: boolean, asAdmin?: false): Promise<UserFields|null>;
    private async findUser(loginId: string, emailOnly: boolean, asAdmin: true): Promise<UserFieldsAdmin|null>;
    private async findUser(loginId: string, emailOnly: boolean = false, asAdmin = false) {
        const username = (!emailOnly && this.mapping.username) ? `${ident(this.mapping.username, this.jc)} = {:loginId}` : null
        const email = this.mapping.email ? `${ident(this.mapping.email, this.jc)} = {:loginId}` : null
        if(!username && !email) throw new HTTPException(500, {message: 'Invalid Configuration'})
        const res = await this.table.$db.rawSelect(this.table, {
            from: this.jc.tableName,
            where: {
                q: (username && email) ? `${username} OR ${email}` : email || username!,
                p: {loginId: loginId}
            },
            selects: this._userFields(true, asAdmin),
            limit: 1,
            _readOnly: true,
        })?.run() ?? []
        return this._fieldsToUser(res[0], true)
    }
    private async getUser(id: string) {
        const res = await this.table.$db.rawSelect(this.table, {
            from: this.jc.tableName,
            where: {
                q: `${ident(this.mapping.uid, this.jc)} = {:uid}`,
                p: {uid: id}
            },
            selects: this._userFields(),
            limit: 1,
            _readOnly: true,
        })?.run() ?? []
        return this._fieldsToUser(res[0])
    }

    private async updateUser(id: string, data: Record<string, SQLLiteral>) {
        const res = await this.table.$db.rawUpdate(this.table, {
            table: this.jc.tableName,
            where: {
                q: `${ident(this.mapping.uid, this.jc)} = {:uid}`,
                p: {uid: id}
            },
            set: data,
            returning: this._userFields(),
        })?.run() ?? []
        return this._fieldsToUser(res[0])
    }

    private async _createUser(data: Required<InsertParams>['values']) {
        const res = await this.table.insert({values: data, returning: this._userFields(false)}) ?? []
        const user = res ? this._fieldsToUser(res[0]) : null
        if (!user) throw new HTTPException(400, {message: 'Unable to create user'}) // todo maybe tell user it can be because of rules?
        return user
    }

    // todo we need to save id of the user from the external platform also.
    // this should only be used for auto user creation
    private async _createUserToken(email: string|undefined, verified: boolean, externalData: any, record?:Record<string, SQLLiteral>, values2 ?:Record<string, SQLLiteral>) {
        if(!this.table.data.autoSetUid) throw new HTTPException(500, {message: 'Invalid Configuration - autoSetUid required for auth extension'})
        const values: Record<string, SQLLiteral> = {
            ...record,
            ...values2,
            [this.mapping.uid]: {l: generateUid()},
        }

        // todo check if email, username, name is not null, unique etc and handle that
        if(this.mapping.email && email)
            values[this.mapping.email] = {l: email}
        if(this.mapping.emailVerified)
            values[this.mapping.emailVerified] = {l: verified}
        if(this.mapping.username)
            values[this.mapping.username] = {l: externalData.username || email?.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '') || ''}
        if(this.mapping.name)
            values[this.mapping.name] = {l: externalData.name || 'User'}

        // if(this.mapping.avatar) // todo avatar url

        // todo put whole externalData in raw_user_meta_data like supabase

        if(this.data.passwordType && this.mapping.password && !values[this.mapping.password]){
            let pass = generateUid()
            const salt = this.mapping.passwordSalt ? randomString(SALT_LENGTH) : ''
            pass = await this._hashPassword(pass, salt)
            values[this.mapping.password] = {l: pass}
            if(this.mapping.passwordSalt) values[this.mapping.passwordSalt] = {l: salt}
        }

        const baseUsername = externalData.username || email?.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '')||''
        const maxRetries = 5
        let lastError: any = null
        let isConstraintError: boolean = false

        for(let attempt = 0; attempt < maxRetries; attempt++) {
            if(this.mapping.username) {
                // On first attempt, use base username; on retries, append random suffix
                const username = attempt === 0 ? baseUsername : `${baseUsername}_${randomString(4).toLowerCase()}`
                values[this.mapping.username] = {l: username}
            }

            isConstraintError = false
            try {
                const res = await this.table.$db.rawInsert(this.table, {
                    table: this.jc.tableName,
                    values: {...values},
                    returning: this._userFields(),
                })?.run() ?? []
                return this._fieldsToUser(res[0])
            } catch (error: any) {
                lastError = error
                if(error instanceof D1Error){
                    // edata structure for reference:
                    //  {
                    //   "error": "UNIQUE constraint failed: users.username: SQLITE_CONSTRAINT",
                    //   "username": {
                    //     "code": "SQLITE_CONSTRAINT",
                    //     "message": "UNIQUE constraint failed"
                    //   }
                    //  }
                    const edata = error.data
                    // Check if it's a username constraint violation specifically

                    // const errStr = edata?.error || error.message || ''
                    // const isUniqueConstraint = errStr.toLowerCase().includes('unique constraint failed')

                    const col = this.mapping.username && edata ? edata[this.mapping.username] : undefined
                    isConstraintError = col && col.code?.toUpperCase() === 'SQLITE_CONSTRAINT' && (
                        col.errorMessage?.toLowerCase().includes('unique constraint failed') ||
                        col.constraint?.toUpperCase() === 'UNIQUE'
                    )
                    // console.error(`Attempt ${attempt + 1} failed with error:`, errStr)
                    // console.error(JSON.stringify(edata, null, 2), isConstraintError)
                }
            }
            if(isConstraintError && attempt < maxRetries - 1) {
                // Retry with a different username
                continue
            }
            // If not a constraint error or max retries reached, throw the error
            break
        }

        throw lastError || new HTTPException(500, {message: 'Failed to create user after multiple attempts'})
    }

    private _fieldsToUser(res: any, asAdmin?: false): UserFields|null;
    private _fieldsToUser(res: any, asAdmin?: true): UserFieldsAdmin|null;
    private _fieldsToUser(res: any, asAdmin: boolean = false): UserFieldsAdmin|null {
        return res ? {
            id: res[this.mapping.uid],
            username: this.mapping.username ? res[this.mapping.username] : undefined,
            email: this.mapping.email ? res[this.mapping.email] : undefined,
            password: asAdmin && this.mapping.password ? res[this.mapping.password] : undefined,
            passwordSalt: asAdmin && this.mapping.passwordSalt ? res[this.mapping.passwordSalt] : undefined,
            emailVerified: this.mapping.emailVerified ? Boolean(res[this.mapping.emailVerified]) : undefined,
            audience: this.mapping.audience ? this.mapping.audience.map((f) => res[f]).filter(v=>v) : undefined,
            metadata: this.mapping.metadata ? JSON.parse(res[this.mapping.metadata]) : undefined,
        } : null
    }
    private _userToFields(user: UserFields|UserFieldsAdmin) {
        const res = {
            [this.mapping.uid]: user.id,
        } as Record<string, z.infer<typeof sqlValSchema>>
        if(this.mapping.username) res[this.mapping.username] = user.username!
        if(this.mapping.email) res[this.mapping.email] = user.email!
        // if(this.mapping.password) res[this.mapping.password] = user.password!
        // if(this.mapping.passwordSalt) res[this.mapping.passwordSalt] = user.passwordSalt!
        if(this.mapping.emailVerified) res[this.mapping.emailVerified] = user.emailVerified!
        if(this.mapping.metadata) res[this.mapping.metadata] = JSON.stringify(user.metadata)
        return res
    }

    private _userFields(identifier = true, asAdmin = false){
        const f = [
            this.mapping.uid, this.mapping.username, this.mapping.email,
            this.mapping.password, this.mapping.passwordSalt,
            this.mapping.emailVerified, ...this.mapping.audience??[],
            this.mapping.metadata,
        ].filter(v => {
            const f = v ? this.table.fields[v]:undefined
            return f && (!f.noSelect || asAdmin)
        }) as string[]
        const jc = !asAdmin ? this.jc : {
            ...this.jc,
            _checkColumns: !asAdmin, // todo see if we can pass asAdmin(or something) and that would include the password columns
        }
        return !identifier ? f : f.map(v => ident(v, jc))
    }

    private _kvVerificationSentKey = (user: UserFields)=> '@email_verification_sent_at_' + this.table.name + user.id
    private _kvTokenKey = (token: string)=> '@token_' + token // + this.table.name + user.id
    private _kvSessionKey = (user: {id: string}, id: string)=> '@session_' + this.table.name + user.id + '_' + id // + this.table.name + user.id
    private _kvPasswordResetSentKey = (user: UserFields)=> '@password_reset_sent_at_' + this.table.name + user.id

    private async _invalidateAllUserSessions(userId: string) {
        // todo get all keys with prefix and delete them
    }

    private _getEmailVars(){
        return {
            APP_NAME: this.table.$db.settings.appName || 'Dollar App',
            APP_URL: this.table.$db.settings.appUrl,
            // todo add RECORD:* for record specific data(username, name, email, role etc) like in pocketbase
        }
    }

    private async _requestVerification(user: UserFields){
        if(!this.mapping.emailVerified) throw new HTTPException(500, {message: 'Invalid Configuration - emailVerified field required'})
        if(!this.mapping.email) throw new HTTPException(500, {message: 'Invalid Configuration - email field required'})
        if(!user.email) throw new HTTPException(500, {message: 'No user'})
        if(user.emailVerified) return

        const verificationKey = this._kvVerificationSentKey(user)
        const emailVerifyEmailDuration = this.data.emailVerifyEmailDuration || 2 * 60 // 2 min

        // this check is to prevent sending verification email too often
        // every email will generate and send a new token but previous ones will still keep working
        const res = await this.table.$db.kv.get<number>(verificationKey, '(unixepoch(CURRENT_TIMESTAMP) - unixepoch(value))')
        if(res !== null && res < emailVerifyEmailDuration-1){
            // throw new Error('Verification email already sent') // todo better error for frontend
            throw new HTTPException(400, {message: 'Verification email already sent'})
        }

        // const token = await this.table.$db.jwt.createJwtToken<{typ: string, cid: string}>({
        //     id: user.id,
        //     sub: user.email,
        //     typ: 'verify_email',
        //     cid: this.table.name,
        // }, await this.jwtSecret(), this.data.emailVerifyTokenDuration || 1 * 60 * 60)
        const token = generateUid()

        const email = this.table.$db.email
        if(!email) throw new HTTPException(500, {message: 'Email not configured'})

        const template = this.data.emailTemplates?.verification || {}

        // todo move defaults out of class
        await email.sendActionLink({
            subject: template.subject || 'Verify your {{APP_NAME}} email',
            tags: ['email-verification', 'table-'+this.table.name, ...(template.tags||[])],
            to: user.email,
            variables: {
                message_title: 'Email Verification',
                message_description: 'Thank you for joining us at {{APP_NAME}}. Click the button below to verify your email address.',
                message_footer: 'If you did not request this, please ignore this email.',
                action_text: 'Verify Email',
                action_link: '{{APP_URL}}/verify-email/{{TOKEN}}',
                ...template.variables,
                TOKEN: token,
                ...this._getEmailVars(),
            }
        })

        const verificationTokenKey = this._kvTokenKey(token)
        const emailVerifyTokenDuration = this.data.emailVerifyTokenDuration || 1 * 60 * 60 // 1 hour

        // await this.table.$db.kv.setSql(verificationKey, 'CURRENT_TIMESTAMP')
        await this.table.$db.kv.setMultiple({
            [verificationKey]: {sql: 'CURRENT_TIMESTAMP'},
            [verificationTokenKey + token]: JSON.stringify({id: user.id, sub: user.email, typ: 'verify_email', cid: this.table.name,}),
        }, emailVerifyTokenDuration)
        // no need to save token as the user is verified when the token is used, or the token expires.
    }

    private async _confirmVerification(token: string, uid?: string){
        if(!this.mapping.emailVerified) throw new HTTPException(500, {message: 'Invalid Configuration - emailVerified field required'})

        const {id, sub} = await this._useToken(token, 'verify_email')
        if(uid && uid !== id) throw new Error('User mismatch')

        const user = await this.findUser(sub, true)
        if(!user || user.id !== id) throw new HTTPException(400, {message: 'Invalid user'})
        if(user.emailVerified) return user

        const user2 = await this.updateUser(user.id, {
            [this.mapping.emailVerified]: {l: true},
        })
        if(!user2) throw new HTTPException(500, {message: 'Failed to verify email'})
        return user2
    }

    private async _requestPasswordReset(user: UserFields){
        if(!this.mapping.password) throw new HTTPException(500, {message: 'Invalid Configuration - password field required'})
        if(!user.email) throw new HTTPException(500, {message: 'No user'})

        const resetKey = this._kvPasswordResetSentKey(user)
        const passwordResetEmailDuration = this.data.passwordResetEmailDuration || 2 * 60 // 2 min

        // every email will generate and send a new token but previous ones will still keep working
        const res = await this.table.$db.kv.get<number>(resetKey, '(unixepoch(CURRENT_TIMESTAMP) - unixepoch(value))')
        if(res !== null && res < passwordResetEmailDuration-1){
            throw new Error('Password reset email already sent') // todo better error for frontend
        }

        // const token = await this.table.$db.jwt.createJwtToken<{typ: string, cid: string}>({
        //     id: user.id,
        //     sub: user.email,
        //     typ: 'reset_password',
        //     cid: this.table.name,
        // }, await this.jwtSecret(), this.data.passwordResetTokenDuration || 60 * 60)
        const token = generateUid()

        const email = this.table.$db.email
        if(!email) throw new HTTPException(500, {message: 'Email not configured'})

        const template = this.data.emailTemplates?.passwordReset || {}
        await email.sendActionLink({
            subject: template.subject || 'Reset your {{APP_NAME}} password',
            tags: ['password-reset', 'table-'+this.table.name, ...(template.tags||[])],
            to: user.email,
            variables: {
                message_title: 'Password Reset',
                message_description: 'Click the button below to reset the password for your {{APP_NAME}} account.',
                message_footer: 'If you did not request this, you can safely ignore this email.',
                action_text: 'Reset Password',
                action_link: '{{APP_URL}}/reset-password/{{TOKEN}}',
                ...template.variables,
                TOKEN: token,
                ...this._getEmailVars(),
            }
        })

        const resetTokenKey = this._kvTokenKey(token)
        const passwordResetTokenDuration = this.data.passwordResetTokenDuration || 60 * 60 // 1 hour

        await this.table.$db.kv.setMultiple({
            [resetKey]: {sql: 'CURRENT_TIMESTAMP'},
            [resetTokenKey + token]: JSON.stringify({id: user.id, sub: user.email, typ: 'reset_password', cid: this.table.name}),
        }, passwordResetTokenDuration)
    }

    // record should have password, passwordSalt
    async _confirmPasswordReset(token: string, record: Record<string, SQLLiteral>){
        if(!this.mapping.password) throw new HTTPException(500, {message: 'Invalid Configuration - password field required'})

        // todo use token after password reset is successful otherwise its annoying
        const {id, sub} = await this._useToken(token, 'reset_password')

        const user = await this.getUser(id)
        if(!user || user.id !== id) throw new HTTPException(400, {message: 'Invalid user'})

        // const resetTokenKey = this._kvPasswordResetTokenKey(user)
        // const tokenSaved = await this.table.$db.kv.get(resetTokenKey)
        // if(token !== tokenSaved) throw new HTTPException(400, {message: 'Invalid token (mismatch)'})

        if(sub !== user.email)  // todo is there any case for this? (pocketbase also has this check for unverified emails)
            throw new HTTPException(400, {message: 'Invalid email'})

        const data = {} as Record<string, SQLLiteral>
        if(this.mapping.passwordSalt) {
            const salt = record[this.mapping.passwordSalt]
            if(!salt.l) throw new HTTPException(500, {message: 'Invalid salt'})
            data[this.mapping.passwordSalt] = salt
        }
        data[this.mapping.password] = record[this.mapping.password]
        if(this.mapping.emailVerified && !user.emailVerified) data[this.mapping.emailVerified] = {l: true}

        const user2 = await this.updateUser(user.id, data)
        if(!user2) throw new HTTPException(500, {message: 'Failed to verify email'})

        // Invalidate all sessions after password reset for security
        const _token = await this._invalidateAllUserSessions(user.id) // todo return token

        // await this.table.$db.kv.remove(resetTokenKey)

        return user2
    }

    private async _useToken(token: string, typ1: string) {
        const res = await this.table.$db.kv.pop<string>(this._kvTokenKey(token))
        let parsed: { id: string, sub: string, typ: string, cid: string } | null = null
        try {
            parsed = res ? JSON.parse(res) : null
        }catch (e) {
            console.error(e)
        }
        if (!parsed) throw new HTTPException(400, {message: 'Invalid token'})
        const {id, sub, typ, cid} = parsed
        // const {id, sub, typ, cid} = await this.table.$db.jwt.decodeAuth(token, await this.jwtSecret(), false)
        if (!id || !sub) throw new HTTPException(400, {message: 'Invalid token'})
        if (cid !== this.table.name) throw new HTTPException(400, {message: 'Invalid table'})
        if (typ !== typ1) throw new HTTPException(400, {message: 'Invalid token type'})
        return {id, sub}
    }

    private async _hashPassword(password: string, salt: string){
        if (!this.data.passwordType) return ''
        return passwordProcessors[this.data.passwordType].hash(password, salt)
    }

    private _parseUsername(record: Record<string, SQLQuery | SQLLiteral>) {
        if (!this.mapping.username) return
        let val = (record[this.mapping.username] as SQLLiteral)?.l
        if (typeof val !== 'string') throw new HTTPException(400, {message: `${this.mapping.username} must be a value, expressions not support in username`})
        val = zParseWithPath(defaultSchema.username, val, [this.mapping.username])
        record[this.mapping.username] = {l: val}
        return val
    }
    private _parseEmail(record: Record<string, SQLQuery | SQLLiteral>) {
        if (!this.mapping.email) throw new HTTPException(500, {message: 'Invalid Configuration'})
        let val = (record[this.mapping.email] as SQLLiteral)?.l
        if (typeof val !== 'string') throw new HTTPException(400, {message: `${this.mapping.email} must be a value, expressions not support in email`})
        val = zParseWithPath(defaultSchema.email, val, [this.mapping.email])
        if(this.data.normalizeEmail !== false) {
            try{
                val = normalizeEmail(val);
            }catch (e) {
                console.error(e)
                throw new HTTPException(400, {message: `Invalid ${this.mapping.email} format`});
            }
        }
        // todo check domain blocklists
        record[this.mapping.email] = {l: val}
        return val
    }

    private async _parseCurrentPasswordField(record: Record<string, SQLLiteral>, salt: string) {
        let current = record[this.mapping.password! + this.data.passwordCurrentSuffix!]?.l
        if (!current || typeof current !== 'string') throw new HTTPException(400, {message: `${this.mapping.password! + this.data.passwordCurrentSuffix!} is required`})
        current = zParseWithPath(defaultSchema.password, current, [this.mapping.password! + this.data.passwordCurrentSuffix!])
        delete record[this.mapping.password! + this.data.passwordCurrentSuffix!]
        return await this._hashPassword(current, salt)
    }

    private async _parsePasswordFieldUpdate(record: Record<string, SQLLiteral>, query: UpdateQuery, salt?: string) {
        if (!this.data.passwordType) return
        if (!this.mapping.password) throw new HTTPException(500, {message: 'Invalid Configuration'})
        let password = record[this.mapping.password]?.l
        if (!password) {
            if(record[this.mapping.password]) delete record[this.mapping.password]
            if(this.data.passwordConfirmSuffix && record[this.mapping.password+this.data.passwordConfirmSuffix]) delete record[this.mapping.password+this.data.passwordConfirmSuffix]
            return
        }

        const isAdmin = this.jc.globals.auth?.admin
        if (this.data.passwordCurrentSuffix && !isAdmin) {
            if (!this.mapping.passwordSalt || salt) { // todo get the current salt from the db
                let current = await this._parseCurrentPasswordField(record, salt || '')
                const currentQ = literalToQuery(current)
                const where = {
                    q: `${ident(this.mapping.password, this.jc)} = ${currentQ.q}`,
                    p: currentQ.p
                }
                // const simplify = this.c.req.header('$DB_TEST_PARSE_SIMPLIFY_DISABLE') !== 'true'
                // query.where = query.where ? applyBinaryOperator(query.where, where, 'AND', simplify) : where
                appendWhere(query, where)
            } else {
                throw new HTTPException(400, {message: 'Not supported, use change-password route(TBD)'})
            }
        }
        await this._parsePasswordFieldsInsert(record)
    }
    private async _parsePasswordFieldsInsert(record: Record<string, SQLQuery | SQLLiteral>): Promise<SQLLiteral<string>|null> {
        if (this.data.passwordType) {
            const field = this.mapping.password
            if (!field) throw new HTTPException(500, {message: 'Invalid Configuration'})
            let val = (record[field] as SQLLiteral)?.l
            if (!val) throw new HTTPException(400, {message: `${field} is required`})
            if (typeof val !== 'string') throw new HTTPException(400, {message: `${field} must be a value, expressions not support in password`})
            val = zParseWithPath(defaultSchema.password, val, [field])

            if (this.data.passwordConfirmSuffix) {
                const confirmVal = (record[field + this.data.passwordConfirmSuffix] as SQLLiteral)?.l
                // zod match so we get proper errors
                // https://github.com/colinhacks/zod/discussions/1525
                zParseWithPath(z.coerce.boolean().refine(bool => bool == true, {
                    // todo better error message
                    message: `${field} and ${field + this.data.passwordConfirmSuffix} do not match`
                }), confirmVal, [field + this.data.passwordConfirmSuffix])

                if (val !== confirmVal) throw new HTTPException(400, {message: 'unknown zod error'})
                delete record[field + this.data.passwordConfirmSuffix]
            }

            const salt = this.mapping.passwordSalt ? randomString(SALT_LENGTH) : ''
            val = await this._hashPassword(val, salt)

            record[field] = {l: val}
            if (this.mapping.passwordSalt) record[this.mapping.passwordSalt] = {l: salt}
            return record[field] as SQLLiteral<string>
        } else if (this.mapping.password) {
            throw new HTTPException(500, {message: 'Invalid Configuration'})
        }
        return null
    }
    private async _parsePasswordFieldsLogin(record: Record<string, SQLLiteral<string>>, salt: string) {
        if (!this.data.passwordType) return
        const field = this.mapping.password
        if (!field) throw new HTTPException(500, {message: 'Invalid Configuration'})
        let val = (record[field])?.l
        if (typeof val !== 'string') throw new HTTPException(400, {message: `${field} must be a value, expressions not support in password`})
        val = zParseWithPath(defaultSchema.password, val, [field])
        val = await this._hashPassword(val, salt)
        record[field] = {l: val}
        return val
    }

}

export type LoginSession = {
    id: string
    tok: string // refresh token
    cid: string // collection/table id
    uid: string // user id
    sub?: string // user email
    cat: number // created at
    rat: number // refreshed at
    exp?: number // expires at
    rc: number // refresh count
    // todo: ip, user agent, etc
}
