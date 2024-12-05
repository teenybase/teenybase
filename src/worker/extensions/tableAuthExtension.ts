import {z} from 'zod'
import {TableExtension} from '../tableExtension'
import {TableAuthExtensionData} from '../../types/tableExtensions'
import {HTTPException} from 'hono/http-exception'
import {$Table} from '../$Table'
import {ident, JsepContext} from '../../sql/parse/jsep'
import {tableAuthDataSchema} from '../../types/tableExtensions'
import {buildInsertQuery, InsertQuery} from '../../sql/build/insert'
import {literalToQuery} from '../../sql/build/query'
import {buildUpdateQuery, UpdateQuery} from '../../sql/build/update'
import {DeleteQuery} from '../../sql/build/delete'
import {appendWhere, buildSelectQuery, SelectQuery} from '../../sql/build/select'
import {parseRequestBody} from '../util/parseRequestBody'
import {recordToSqlValues} from '../../sql/parse/parse'
import {JWTPayload} from '../../types/jwt'
import {generateUid, randomString} from '../../security/random'
import {SQLLiteral, SQLQuery, sqlValSchema} from '../../types/sql'
import {passwordProcessors} from '../util/passwordProcessors'
import {InsertParams} from '../../sql/parse/insert'

type UserFields = {
    emailVerified?: boolean
    password?: string
    id: string
    passwordSalt?: string
    email?: string
    username?: string
    audience?: string[] // roles
    metadata?: string
}

const SALT_LENGTH = 20

const defaultSchema = {
    username: z.string().min(1).max(32).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/), // username should not include `@`
    password: z.string().min(8, {message: 'Password must be at least 8 characters long'}).max(255, {message: 'Password must be less than 255 characters long'}),
    email: z.string().min(1).max(255).email(),
    identity: z.string().min(1).max(255).email().or(z.string().min(1).max(32).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)), // email or username
    name: z.string().min(1).max(255).optional(),
    emailVerified: z.coerce.boolean().optional(),
}

/*.jwt()*/ // todo use jwt
const jwtTokenSchema = z.string().min(10).describe('JWT token')
// .refine((v) => {
//     z.literal(3).parse(v.split('.').map(a=>z.string().base64().parse(a)).length)
// })

export class TableAuthExtension extends TableExtension<TableAuthExtensionData> {
    static readonly name = 'auth'

    readonly mapping
    private jwtSecret: string

    constructor(data: TableAuthExtensionData, table: $Table, jc: JsepContext) {
        super(tableAuthDataSchema.parse(data), table, jc)
        if (data.name !== TableAuthExtension.name) throw new HTTPException(500, {message: 'Invalid Configuration'})
        if(!this.table.mapping.uid) throw new HTTPException(500, {message: 'Invalid Configuration - id field required'})
        this.jwtSecret = this.table.$db.secretResolver.resolve(this.data.jwtSecret)
        if (!this.jwtSecret?.length) throw new HTTPException(500, {message: 'Invalid configuration - jwt secret is required for table'})
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

        this.routes.push({
            method: 'post', path: '/auth/login-token',
            handler: {raw: this.loginWithToken.bind(this)},
            zod: this.routeZod['/auth/login-token'],
        })

        if(this.mapping.password) {
            this.routes.push({
                method: 'post', path: '/auth/sign-up',
                handler: this.signUp.bind(this),
                zod: this.routeZod['/auth/sign-up'],
            })
            this.routes.push({
                method: 'post', path: '/auth/login-password',
                handler: this.loginWithPassword.bind(this),
                zod: this.routeZod['/auth/login-password'],
            })
            this.routes.push({
                method: 'post', path: '/auth/change-password',
                handler: {raw: this.changePassword.bind(this)},
                zod: this.routeZod['/auth/change-password'],
            })
            this.routes.push({
                method: 'post', path: '/auth/request-password-reset',
                handler: {raw: this.requestPasswordReset.bind(this)},
                zod: this.routeZod['/auth/request-password-reset'],
            })
            this.routes.push({
                method: 'post', path: '/auth/confirm-password-reset',
                handler: {raw: this.confirmPasswordReset.bind(this)},
                zod: this.routeZod['/auth/confirm-password-reset'],
            })
        }
        if(this.mapping.emailVerified) {
            this.routes.push({
                method: 'post', path: '/auth/request-verification',
                handler: {raw: this.requestVerification.bind(this)},
                zod: this.routeZod['/auth/request-verification'],
            })
            this.routes.push({
                method: 'post', path: '/auth/confirm-verification',
                handler: {raw: this.confirmVerification.bind(this)},
                zod: this.routeZod['/auth/confirm-verification'],
            })
        }

    }

    async onInsertParse(query: InsertQuery) {
        const v = query.values
        const records = Array.isArray(v) ? v : [v]

        for (const record of records) {
            await this._parsePasswordFieldsInsert(record)

            this._parseUsername(record)

            if (this.mapping.email) this._parseEmail(record)
            if (this.mapping.name) defaultSchema.name.parse((record[this.mapping.name] as SQLLiteral)?.l)

            if (this.mapping.emailVerified) {
                let val = defaultSchema.emailVerified.parse((record[this.mapping.emailVerified] as SQLLiteral)?.l)

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
            record: Record<string, z.infer<typeof sqlValSchema>>,
            verified?: boolean,
        } = {
            token: await this.createLoginToken(user),
            record: this._userToFields(user),
        }
        if(this.mapping.emailVerified) {
            ret.verified = user.emailVerified
            if(!user.emailVerified && this.data.autoSendVerificationEmail){
                this.jc.c.executionCtx.waitUntil(this._requestVerification(user))
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
        return this.jc.c.json({success: true})
    }

    confirmRequiresAuth = true  // todo make setting
    async confirmVerification(){
        const data = await parseRequestBody(this.jc.c.req)
        if (!data) throw new HTTPException(400, {message: 'Usage: POST /auth/confirm-verification {data} in JSON/FormData'})
        // console.log(data.token)
        const token = jwtTokenSchema.parse(data.token)
        if(!token) throw new HTTPException(400, {message: 'Token required'})

        const auth = this.jc.globals.auth
        if(this.confirmRequiresAuth && !auth) throw new HTTPException(403, {message: 'Unauthorized'})
        const uid = this.confirmRequiresAuth ? auth!.uid||undefined : undefined

        const user = await this._confirmVerification(token, uid)
        const ret = {
            token: await this.createLoginToken(user),
            record: this._userToFields(user),
        } as any
        return this.jc.c.json(ret)
    }

    async requestPasswordReset(){
        if(!this.mapping.email || !this.mapping.password) throw new HTTPException(500, {message: 'Invalid Configuration'})

        const data = await parseRequestBody(this.jc.c.req)
        if(!data) throw new HTTPException(400, {message: 'Usage: POST /auth/request-password-reset {data} in JSON/FormData'})

        const record = recordToSqlValues(data)
        const email = this._parseEmail(record)

        const user = await this.findUser(email, true)
        if(!user) throw new HTTPException(400, {message: 'User not found'})
        const auth = this.jc.globals.auth
        // auth is optional here. todo make this configurable
        if(auth?.uid && (auth.uid !== user.id || auth.email !== email)) throw new HTTPException(403, {message: 'Unauthorized'})

        await this._requestPasswordReset(user)

        return this.jc.c.json({success: true})
    }

    async confirmPasswordReset(){
        if(!this.mapping.email || !this.mapping.password) throw new HTTPException(500, {message: 'Invalid Configuration'})
        const data = await parseRequestBody(this.jc.c.req)
        if (!data) throw new HTTPException(400, {message: 'Usage: POST /auth/confirm-password-reset {data} in JSON/FormData'})
        const token = jwtTokenSchema.parse(data.token)
        if(!token) throw new HTTPException(400, {message: 'Token required'})
        delete data.token

        const record = recordToSqlValues(data)
        const password = await this._parsePasswordFieldsInsert(record)
        if(!password) throw new HTTPException(400, {message: 'Invalid password'})

        const user = await this._confirmPasswordReset(token, record)
        const ret = {
            token: await this.createLoginToken(user),
            record: this._userToFields(user),
        } as any
        return this.jc.c.json(ret)
    }

    async loginWithPassword(data?: Record<string, z.infer<typeof sqlValSchema>>){
        if(!this.mapping.password) throw new HTTPException(500, {message: 'Invalid Configuration'})

        if (!data) throw new HTTPException(400, {message: 'Usage: POST /auth/login-password {data} in JSON'})

        const record = recordToSqlValues(data)
        const username = (this.mapping.email && record[this.mapping.email]) ? this._parseEmail(record) :
            record['identity'] ? defaultSchema.identity.parse(record['identity'].l) :
            this._parseUsername(record)

        const invalid = async()=>{
            await new Promise((r)=>setTimeout(r, Math.random()*200)) // todo
            return new HTTPException(400, {message: 'Invalid username or password'})
        }
        const user = username ? await this.findUser(username) : null

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

        const ret: {token: string, record: any, verified?: false} = {
            token: await this.createLoginToken(user),
            record: this._userToFields(user),
        }
        if(this.mapping.emailVerified && !user.emailVerified) ret.verified = false
        // return this.jc.c.json(ret)
        return ret
    }

    /**
     * validates token from google, github etc or refreshes the token
     */
    async loginWithToken(){
        const tok = this.jc.c.req.header('Authorization')?.replace(/^Bearer /, '')
        if (!tok) throw new HTTPException(400, {message: 'Authorization header required'})
        const payload = await this.table.$db.jwt.decodeAuth(tok, this.jwtSecret, false).catch(() => null)
        if (!payload) throw new HTTPException(401, {message: 'Unauthorized'})

        let res = await this.findUser(payload.sub)

        if(payload.iss !== this.table.$db.jwt.issuer){
            // todo why this false and 0 check? because it can be 'true'?
            if(payload.verified === false || (payload as any).verified === 0) throw new HTTPException(400, {message: 'Not verified'})
            // todo make a setting in this.data to control whether a new user should be created on new token or should it be explicit
            if(!res) res = await this._createUserToken(payload.sub, true, payload)
        }

        if(!res) throw new HTTPException(401, {message: 'Unauthorized'})

        // if(this.mapping.emailVerified && !res.emailVerified) throw new HTTPException(400, {message: 'Email not verified'})
        if(res.email !== payload.sub) throw new HTTPException(400, {message: 'Invalid email'})

        const refreshCount = payload.rc||0
        const token = refreshCount < this.data.maxTokenRefresh ?
            await this.createLoginToken(res, refreshCount + 1) : tok

        const ret = {token} as {token: string, verified?: false}
        if(this.mapping.emailVerified && !res.emailVerified) ret.verified = false
        // todo return record like loginWithPassword?
        return this.jc.c.json(ret)
    }

    async changePassword(){
        if(!this.data.passwordType) throw new HTTPException(500, {message: 'Invalid Configuration'})

        const email = this.jc.globals.auth?.email
        if(!this.jc.globals.auth?.uid || !email) throw new HTTPException(401, {message: 'Unauthorized'})
        const data = await this.jc.c.req.json()
        if (!data) throw new HTTPException(400, {message: 'Usage: POST /auth/change-password {data} in JSON'})

        const record = recordToSqlValues(data)
        const res = await this.findUser(email)
        if(!res) throw new HTTPException(400, {message: 'Invalid user'})

        const salt = res.passwordSalt || ''

        if(this.data.passwordCurrentSuffix) {
            let current = await this._parseCurrentPasswordField(record, salt)
            if(current !== res.password) throw new HTTPException(400, {message: 'Invalid current password'})
        }

        const password = await this._parsePasswordFieldsInsert(record)
        if(!password) throw new HTTPException(400, {message: 'Invalid password'})

        const res2 = await this.updateUser(res.id, {password: password})
        if(!res2 || res2.id !== res.id) throw new HTTPException(500, {message: 'Failed to update password'})

        return this.jc.c.json({success: true})
    }

// todo
    // login with token
    // reset/forgot password
    // username change
    // username recovery

    // no point of this for this frontend, just use normal token. auth0 also says no point - https://auth0.com/blog/refresh-tokens-what-are-they-and-when-to-use-them/
    // actually useful to update meta and stuff
    // refresh token


    private async createLoginToken(res: UserFields, rc = 0) {
        const data = {
            cid: this.table.data.name,
            user: res.username, // todo: should this be added?
            sub: res.email,
            id: res.id,
            meta: res.metadata,
            // admin: false,
        } as JWTPayload
        if(rc) data.rc = rc
        if(res.audience && res.audience.length) data.aud = res.audience
        if(res.emailVerified !== undefined) data.verified = res.emailVerified
        return await this.table.$db.jwt.createJwtToken(data, this.jwtSecret, this.data.jwtTokenDuration)
    }

    /**
     * @param loginId - username or email
     * @param emailOnly
     * @private
     */
    private async findUser(loginId: string, emailOnly: boolean = false) {
        const username = (!emailOnly && this.mapping.username) ? `${ident(this.mapping.username, this.jc)} = {:loginId}` : null
        const email = this.mapping.email ? `${ident(this.mapping.email, this.jc)} = {:loginId}` : null
        if(!username && !email) throw new HTTPException(500, {message: 'Invalid Configuration'})
        const select = buildSelectQuery({
            from: this.jc.tableName,
            where: {
                q: (username && email) ? `${username} OR ${email}` : email || username!,
                p: {loginId: loginId}
            },
            selects: this._userFields(),
            limit: 1,
        })

        const res = await this.table.run(select, 'Failed to find user')
        return this._fieldsToUser(res[0])
    }
    private async getUser(id: string) {
        const select = buildSelectQuery({
            from: this.jc.tableName,
            where: {
                q: `${ident(this.mapping.uid, this.jc)} = {:uid}`,
                p: {uid: id}
            },
            selects: this._userFields(),
            limit: 1,
        })

        const res = await this.table.run(select, 'Failed to find user by id')
        return this._fieldsToUser(res[0])
    }

    private async updateUser(id: string, data: Record<string, SQLLiteral>) {
        const update = buildUpdateQuery({
            table: this.jc.tableName,
            where: {
                q: `${ident(this.mapping.uid, this.jc)} = {:uid}`,
                p: {uid: id}
            },
            set: data,
            returning: this._userFields(),
        })

        const res = await this.table.run(update, 'Failed to run user update query')
        return this._fieldsToUser(res[0])
    }

    private async _createUser(data: Required<InsertParams>['values']) {
        const res = await this.table.insert({values: data, returning: this._userFields(false)})
        const user = res ? this._fieldsToUser(res[0]) : null
        if (!user) throw new HTTPException(400, {message: 'Unable to create user'})
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
        if(this.mapping.email && email)
            values[this.mapping.email] = {l: email}
        if(this.mapping.emailVerified)
            values[this.mapping.emailVerified] = {l: verified}
        if(this.mapping.username)
            values[this.mapping.username] = {l: externalData.username || email?.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '')||''}
        if(this.mapping.name && externalData.name)
            values[this.mapping.name] = {l: externalData.name}

        if(this.data.passwordType && this.mapping.password && !values[this.mapping.password]){
            let pass = generateUid()
            const salt = this.mapping.passwordSalt ? randomString(SALT_LENGTH) : ''
            pass = await this.hashPassword(pass, salt)
            values[this.mapping.password] = {l: pass}
            if(this.mapping.passwordSalt) values[this.mapping.passwordSalt] = {l: salt}
        }

        const query  = {
            table: this.jc.tableName,
            values,
            returning: this._userFields(),
        } as InsertQuery
        const insert = buildInsertQuery(query, this.jc.autoSimplifyExpr)
        const res = await this.table.run(insert, 'Failed to run user update query')
        return this._fieldsToUser(res[0])
    }

    private _fieldsToUser(res: any): UserFields|null {
        return res ? {
            id: res[this.mapping.uid],
            username: this.mapping.username ? res[this.mapping.username] : undefined,
            email: this.mapping.email ? res[this.mapping.email] : undefined,
            password: this.mapping.password ? res[this.mapping.password] : undefined,
            passwordSalt: this.mapping.passwordSalt ? res[this.mapping.passwordSalt] : undefined,
            emailVerified: this.mapping.emailVerified ? Boolean(res[this.mapping.emailVerified]) : undefined,
            audience: this.mapping.audience ? this.mapping.audience.map((f) => res[f]).filter(v=>v) : undefined,
            metadata: this.mapping.metadata ? JSON.parse(res[this.mapping.metadata]) : undefined,
        } : null
    }
    private _userToFields(user: UserFields) {
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

    private _userFields(identifier = true){
        const f = [
            this.mapping.uid, this.mapping.username, this.mapping.email,
            this.mapping.password, this.mapping.passwordSalt,
            this.mapping.emailVerified, ...this.mapping.audience??[],
            this.mapping.metadata,
        ].filter(v => v) as string[]
        return !identifier ? f : f.map(v => ident(v, this.jc))
    }

    private _kvVerificationSentKey = (user: UserFields)=> '@email_verification_sent_at_' + this.table.name + user.id
    private _kvPasswordResetSentKey = (user: UserFields)=> '@password_reset_sent_at_' + this.table.name + user.id

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
        const emailVerifyTokenDuration = this.data.emailVerifyTokenDuration || 2 * 60 * 60 * 1000

        const res = await this.table.$db.kv.get<number>(verificationKey, '(CURRENT_TIMESTAMP - CAST(value as INTEGER))')
        if(res !== null && res < emailVerifyTokenDuration-1000){
            // throw new Error('Verification email already sent') // todo better error for frontend
            throw new HTTPException(400, {message: 'Verification email already sent'})
        }

        const token = await this.table.$db.jwt.createJwtToken<{typ: string, cid: string}>({
            id: user.id,
            sub: user.email,
            typ: 'verify_email',
            cid: this.table.name,
        }, this.jwtSecret, emailVerifyTokenDuration)

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

        await this.table.$db.kv.setSql(verificationKey, 'CURRENT_TIMESTAMP')
    }

    private async _confirmVerification(token: string, uid?: string){
        if(!this.mapping.emailVerified) throw new HTTPException(500, {message: 'Invalid Configuration - emailVerified field required'})

        const {id, sub, typ, cid} = await this.table.$db.jwt.decodeAuth(token, this.jwtSecret, false)
        if(!id || !sub) throw new HTTPException(400, {message: 'Invalid token'})
        if(uid && uid !== id) throw new Error('User mismatch')
        if(cid !== this.table.name) throw new HTTPException(400, {message: 'Invalid table'})
        if(typ !== 'verify_email') throw new HTTPException(400, {message: 'Invalid token type'})

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
        const passwordResetTokenDuration = this.data.passwordResetTokenDuration || 20 * 60 * 60 * 1000

        const res = await this.table.$db.kv.get<number>(resetKey, '(CURRENT_TIMESTAMP - CAST(value as INTEGER))')
        if(res !== null && res < passwordResetTokenDuration-1000){
            throw new Error('Password reset email already sent') // todo better error for frontend
        }

        const token = await this.table.$db.jwt.createJwtToken<{typ: string, cid: string}>({
            id: user.id,
            sub: user.email,
            typ: 'reset_password',
            cid: this.table.name,
        }, this.jwtSecret, passwordResetTokenDuration)

        const email = this.table.$db.email
        if(!email) throw new HTTPException(500, {message: 'Email not configured'})

        const template = this.data.emailTemplates?.passwordReset || {}
        await email.sendActionLink({
            subject: template.subject || 'Reset your {{APP_NAME}} password',
            tags: ['password-reset', 'table-'+this.table.name, ...(template.tags||[])],
            to: user.email,
            variables: {
                message_title: 'Password Reset',
                message_description: 'Click the button below to reset your password for your {{APP_NAME}} account.',
                message_footer: 'If you did not request this, you can safely ignore this email.',
                action_text: 'Reset Password',
                action_link: '{{APP_URL}}/reset-password/{{TOKEN}}',
                ...template.variables,
                TOKEN: token,
                ...this._getEmailVars(),
            }
        })

        await this.table.$db.kv.setSql(resetKey, 'CURRENT_TIMESTAMP')
    }

    // record should have password, passwordSalt
    async _confirmPasswordReset(token: string, record: Record<string, SQLLiteral>){
        if(!this.mapping.password) throw new HTTPException(500, {message: 'Invalid Configuration - password field required'})

        const {id, sub, typ, cid} = await this.table.$db.jwt.decodeAuth(token, this.jwtSecret, false)
        if(!id || !sub) throw new HTTPException(400, {message: 'Invalid token'})
        if(cid !== this.table.name) throw new HTTPException(400, {message: 'Invalid table'})
        if(typ !== 'reset_password') throw new HTTPException(400, {message: 'Invalid token type'})

        const user = await this.getUser(id)
        if(!user || user.id !== id) throw new HTTPException(400, {message: 'Invalid user'})

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
        return user2
    }

    private async hashPassword(password: string, salt: string){
        if (!this.data.passwordType) return ''
        return passwordProcessors[this.data.passwordType].hash(password, salt)
    }


    private _parseUsername(record: Record<string, SQLQuery | SQLLiteral>) {
        if (!this.mapping.username) return
        let val = (record[this.mapping.username] as SQLLiteral)?.l
        if (typeof val !== 'string') throw new HTTPException(400, {message: `${this.mapping.username} must be a value, expressions not support in username`})
        val = defaultSchema.username.parse(val)
        return val
    }
    private _parseEmail(record: Record<string, SQLQuery | SQLLiteral>) {
        if (!this.mapping.email) throw new HTTPException(500, {message: 'Invalid Configuration'})
        let val = (record[this.mapping.email] as SQLLiteral)?.l
        if (typeof val !== 'string') throw new HTTPException(400, {message: `${this.mapping.email} must be a value, expressions not support in email`})
        val = defaultSchema.email.parse(val)
        return val
    }

    private async _parseCurrentPasswordField(record: Record<string, SQLLiteral>, salt: string) {
        let current = record[this.mapping.password! + this.data.passwordCurrentSuffix!]?.l
        if (!current || typeof current !== 'string') throw new HTTPException(400, {message: `${this.mapping.password! + this.data.passwordCurrentSuffix!} is required`})
        current = defaultSchema.password.parse(current)
        return await this.hashPassword(current, salt)
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
                // const simplify = this.jc.c.req.header('$DB_TEST_PARSE_SIMPLIFY_DISABLE') !== 'true'
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
            if (typeof val !== 'string') throw new HTTPException(400, {message: `${field} must be a value, expressions not support in password`})
            val = defaultSchema.password.parse(val)

            if (this.data.passwordConfirmSuffix) {
                const confirmVal = (record[field + this.data.passwordConfirmSuffix] as SQLLiteral)?.l
                if (val !== confirmVal) throw new HTTPException(400, {message: `${field} and ${field + this.data.passwordConfirmSuffix} do not match`})
                delete record[field + this.data.passwordConfirmSuffix]
            }

            const salt = this.mapping.passwordSalt ? randomString(SALT_LENGTH) : ''
            val = await this.hashPassword(val, salt)

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
        val = defaultSchema.password.parse(val)
        val = await this.hashPassword(val, salt)
        record[field] = {l: val}
        return val
    }

    protected routeZod = {
        '/auth/login-token': ()=>({
            description: 'Login with token',
            request: {headers: z.object({Authorization: z.string().min(10)})},
            responses: {
                '200': {
                    description: 'Success',
                    content: {'application/json': {
                            schema: z.object({
                                token: jwtTokenSchema,
                                verified: z.boolean().optional().describe('Email verified. (only returned if false)')
                            }),
                        }},
                },
            }
        }),
        '/auth/': ()=>({
            description: 'Login with token',
            request: {headers: z.object({Authorization: z.string().min(10)})},
            responses: {
                '200': {
                    description: 'Success',
                    content: {'application/json': {
                            schema: z.object({
                                token: jwtTokenSchema,
                                verified: z.boolean().optional().describe('Email verified. (only returned if false)')
                            }),
                        }},
                },
            }
        }),
        '/auth/sign-up': ()=>({
            description: 'Sign up. (similar to insert, but returns the login token along with the record)',
            request: {body: {
                    required: true,
                    content: {'application/json': {schema: this.table.zodSchema}}, // todo we can pick the fields here based on user fields mapping
                    description: 'Data to insert in the table along with passwordConfirm',
                }},
            responses: {
                '200': {
                    description: 'Success',
                    content: {'application/json': {
                            schema: z.object({
                                token: jwtTokenSchema,
                                verified: z.boolean().optional().describe('Email verified.'),
                                record: this.table.zodSchema, // todo we can pick the fields here based on user fields mapping
                            }),
                        }},
                },
            }
        }),
        '/auth/login-password': ()=>({
            description: 'Login with password',
            request: {body: {
                    required: true,
                    content: {'application/json': {schema: z.object({
                                identity: defaultSchema.identity.describe('Email or username'),
                                // [this.mapping.password]: defaultSchema.password,
                            }).or(z.record(z.string(), z.unknown()))}}, // todo we can pick the fields here based on user fields mapping
                    description: 'identity/email/username and password',
                }},
            responses: {
                '200': {
                    description: 'Success',
                    content: {'application/json': {
                            schema: z.object({
                                token: jwtTokenSchema,
                                record: this.table.zodSchema, // todo we can pick the fields here based on user fields mapping
                            }),
                        }},
                },
            }
        }),
        '/auth/change-password': ()=>({
            description: 'Change password',
            request: {body: {
                    required: true,
                    content: {'application/json': {schema: z.object({
                                // [this.mapping.password]: defaultSchema.password,
                            }).or(z.record(z.string(), z.unknown()))}}, // todo we can pick the fields here based on user fields mapping
                    description: 'The current password, new password and new password confirm and changes the password',
                }},
            responses: {
                '200': {
                    description: 'Success',
                    content: {'application/json': {
                            schema: z.object({
                                success: z.literal(true),
                            }),
                        }},
                },
            }
        }),
        '/auth/request-password-reset': ()=>({
            description: 'Request password reset. Sends an email to the user with a token to reset the password. (doesn\'t require login)',
            request: {
                body: {
                    required: true,
                    content: {'application/json': {schema: z.object({
                                // email: defaultSchema.identity.describe('Email field'), // todo
                            }).or(z.record(z.string(), z.unknown()))}},
                    description: 'identity/email/username',
                }
            },
            responses: {
                '200': {
                    description: 'Success',
                    content: {'application/json': {
                            schema: z.object({success: z.literal(true),}),
                        }},
                },
            }
        }),
        '/auth/confirm-password-reset': ()=>({
            description: 'Confirm password reset. Sends an email to the user with a token to reset the password.',
            request: {
                body: {
                    required: true,
                    content: {'application/json': {schema: z.object({
                                token: jwtTokenSchema,
                            }).and(z.record(z.string(), z.unknown()))}}, // todo password fields
                    description: 'token and new password and new password confirm',
                }
            },
            responses: {
                '200': {
                    description: 'Success',
                    schema: z.object({
                        token: jwtTokenSchema,
                        record: this.table.zodSchema, // todo we can pick the fields here based on user fields mapping
                    }),
                },
            }
        }),
        '/auth/request-verification': ()=>({
            description: 'Request email verification. Sends an email to the user with a token to verify. (requires login)',
            request: {},
            responses: {
                '200': {
                    description: 'Success',
                    content: {'application/json': {
                            schema: z.object({success: z.literal(true),}),
                        }},
                },
            }
        }),
        '/auth/confirm-verification': ()=>({
            description: 'Confirm email verification with token.',
            request: {
                body: {
                    required: true,
                    content: {'application/json': {schema: z.object({
                                token: jwtTokenSchema,
                            })}},
                    description: 'jwt token received in the email',
                }
            },
            responses: {
                '200': {
                    description: 'Success',
                    schema: z.object({
                        token: jwtTokenSchema,
                        record: this.table.zodSchema, // todo we can pick the fields here based on user fields mapping
                    }),
                },
            }
        }),
    }

}
