import {$Table} from './$Table'
import {Context} from 'hono'
import {HTTPException} from 'hono/http-exception'
import {decode} from '@tsndr/cloudflare-worker-jwt'
import {ProcessError} from './util/error'
import {AuthContext} from '../types/env'
import {AuthProvider, DatabaseSettings, hasIdentitiesExtension} from '../types/config'
import {JWTTokenHelper} from '../security/JWTTokenHelper'
import {EmailSendClient} from './email/send-email'
import {InternalKV} from './internalKV'
import {InternalIdentities} from './InternalIdentities'
import {$Env, envBool} from './env'
import {JWTPayloadOp} from '../types/jwt'
import {TableAuthExtensionData} from '../types/tableExtensions'
import {columnify, createJsepContext, honoToJsep, ident} from '../sql/parse/jsep'
import {logSQLQuery, QueryType} from '../sql/build/query'
import {D1Query, sqlQueryToD1Query} from '../sql/build/d1'
import {z} from 'zod'
import {DBMigration, MigrationHelper} from './migrationHelper'
import {LinearRouter} from 'hono/router/linear-router'
import {parseRequestBody} from './util/parseRequestBody'
import {HttpRoute, RawRouterHandlerFunction} from '../types/route'
import {$DBExtension} from './$DBExtension'
import {SQLQuery, TableInsertParams} from '../types/sql'
import {buildDeleteQuery, DeleteQuery} from '../sql/build/delete'
import {buildInsertQuery, InsertQuery} from '../sql/build/insert'
import {buildUpdateQuery, UpdateQuery} from '../sql/build/update'
import {buildSelectQuery, SelectQuery} from '../sql/build/select'
import {generateUid} from '../security/random'
import {getSQLiteSchema} from '../sql/schema/tableInfo'
import {D1PreparedQuery, D1PreparedTransaction, SQLRunContext, SQLRunTransactionContext} from './util/sql'
import {OptionalOmit} from './util/types'
import {SecretResolver} from './secretResolver'
import {databaseSettingsSchema} from '../types/zod/databaseSettingsSchema'
import {zParseWithPath} from '../utils/zod'
import {deleteCookie, getCookie} from 'hono/cookie'
import {$DatabaseRawImpl} from './$DatabaseRawImpl'
import {parseRuleQuery} from './extensions/tableRulesExtension'
import {StorageAdapter} from './storage/StorageAdapter'
import {DefaultDatabaseAdapter} from './storage/DefaultDatabaseAdapter'
import {httpMetaToHeaders} from './storage/R2RestAdapter'
import {isFieldSelectable} from '../types/config/isFieldSelectable'

// ADMIN_SERVICE_TOKEN length warning is logged once per isolate, not on every request.
let shortAdminTokenLogged = false

/**
 * What an {@link $Database.onSignIn} hook receives. A sign-in is any auth route that hands out a new session:
 * login-password, sign-up, the OAuth callback, google-login, login-token, and the email links that sign in
 * (confirm-verification without a session, confirm-password-reset). refresh-token renews an existing sign-in and
 * does not run the hooks.
 */
export interface SignInEvent<T extends $Env = $Env> {
    /** Name of the auth table the user signed in to. */
    table: string
    /** The user's record as the response returns it (`record`: the auth columns), plus `id`. */
    user: Record<string, string | number | boolean | null> & {id: string}
    /**
     * How the user proved who they are:
     * - `'password'`: login-password or sign-up
     * - `'email'`: an emailed link (confirm-verification, confirm-password-reset)
     * - the OAuth provider name for the OAuth callback (`'github'`, `'google'`, ...)
     * - for login-token and google-login, the token's issuer: `'google'` for Google ID tokens, the `iss` URL otherwise
     */
    provider: string
    /** True when this request created the user row. If a hook throws on that request, the row stays and the next sign-in has `created: false`. */
    created: boolean
    /**
     * What the provider said about the user. OAuth: `{provider, providerId, email, name, avatar, username, verified,
     * rawData}`, where `rawData` is the provider's profile (userinfo response or ID token claims). login-token and
     * google-login: the verified token's claims. Never the provider's access or refresh tokens. Unset for
     * `'password'` and `'email'`.
     */
    external?: Record<string, unknown>
    /** This request's database. The user is not signed in on it yet, so table rules see an anonymous request: write with `db.rawSQL` (no rules). */
    db: $Database<T>
}
/** A sign-in hook: see {@link $Database.onSignIn}. */
export type SignInHook<T extends $Env = $Env> = (event: SignInEvent<T>) => void | Promise<void>

export class $Database<T extends $Env = $Env> extends $DatabaseRawImpl/*<T>*/{
    protected readonly tables: Record<string, $Table<T>> = {}
    readonly settings: DatabaseSettings
    readonly queryLog: string[] = []

    /**
     * Hooks that run on every sign-in (see {@link SignInEvent} for which routes), after the user row is found or
     * created and before the session and cookie are created. Register them where the `$Database` is created (the
     * `teenyHono` callback), not in the config, which is JSON:
     * ```ts
     * db.onSignIn.push(async ({provider, user, db}) => {
     *     if (provider === 'github') await db.rawSQL({q: 'UPDATE users SET handle_set = 1 WHERE id = ?', v: [user.id]}).run()
     * })
     * ```
     * Hooks run in order and are awaited. One that throws fails the sign-in with that error (an `HTTPException`
     * keeps its status) and no session or cookie is created. When any hook is registered, the user row is read
     * again after the hooks, so changes to auth columns (role, meta, username) are in the new token and `record`.
     */
    readonly onSignIn: SignInHook<T>[] = []

    readonly email: EmailSendClient<T> | null
    // readonly notify: NotifyClient
    readonly jwt: JWTTokenHelper
    readonly kv: InternalKV/*<T>*/
    readonly identities: InternalIdentities | null
    readonly extensions: $DBExtension<T>[] = []

    public readonly c: Context<T>
    readonly secretResolver: SecretResolver

    private readonly adminJwtSecret: ()=>Promise<string>

    // TODO: Remove D1Database acceptance once multiple adapters exist (for tree-shaking)
    constructor(c: Context<T>, settings: z.infer<typeof databaseSettingsSchema>|DatabaseSettings|undefined, adapter?: StorageAdapter | D1Database, storage?: R2Bucket) {
        super(adapter ?? new DefaultDatabaseAdapter(
            // `settings` is validated below inside this constructor; until then, extract
            // database config in a best-effort way — the same parse happens on the next line.
            (typeof settings === 'object' && settings && 'database' in settings ? (settings as any).database : undefined),
            c.env,
        ))
        this.c = c
        if((c.env as any).IS_VITEST){
            const h = c.req.header('$DB_TEST_DATABASE_SETTINGS')
            if(h) settings = JSON.parse(h) as DatabaseSettings
        }
        this.settings = databaseSettingsSchema.parse(settings ?? JSON.parse(c.env.DATABASE_SETTINGS||''))
        this.storage = storage
        this.kv = new InternalKV(this, this.settings._kvTableName)
        this.identities = hasIdentitiesExtension(this.settings) ? new InternalIdentities(this) : null
        this.extensions.push(new MigrationHelper(this, this.kv, undefined)) // todo migration table name is fixed
        this.secretResolver = new SecretResolver(()=>c.env, SecretResolver.DEFAULT_KEY_ENV)

        // Admin frontend sets this to make sure we're talking to the correct deployment
        // of the worker. Mismatch = frontend's view is ahead of this worker's bundle →
        // frontend retries/warns. todo set in frontend
        const sv = c.req.header('DDB_SETTINGS_VERSION')
        if (sv && parseInt(sv) !== this.settings.version) {
            throw new HTTPException(500, {message: 'DDB_SETTINGS_VERSION_MISMATCH'})
        }
        c.set('settings', this.settings) // todo is this required? we are setting $db also

        if (this.c.get('auth')) this.auth = this.c.get('auth')!
        else c.set('auth', this.auth);

        const cfEmailConfig = this.settings.email?.cloudflare
        const cfEmailBindingName = cfEmailConfig?.binding || 'EMAIL'
        this.email = this.settings.email ? new EmailSendClient(this, {
            from: this.settings.email.from || undefined,
            variables: this.settings.email.variables,
            tags: this.settings.email.tags || [],
        }, this.settings.email.mailgun ? {
            ...this.settings.email.mailgun,
            MAILGUN_API_KEY: this.secretResolver.resolver(this.settings.email?.mailgun?.MAILGUN_API_KEY, false),
            MAILGUN_WEBHOOK_SIGNING_KEY: this.secretResolver.resolver(this.settings.email?.mailgun?.MAILGUN_WEBHOOK_SIGNING_KEY, false),
        } : undefined, this.settings.email.resend ? {
            ...this.settings.email.resend,
            RESEND_API_KEY: this.secretResolver.resolver(this.settings.email?.resend?.RESEND_API_KEY, false),
            RESEND_WEBHOOK_SECRET: this.secretResolver.resolver(this.settings.email?.resend?.RESEND_WEBHOOK_SECRET, false),
        } : undefined, cfEmailConfig ? {
            ...cfEmailConfig,
            binding: () => (c.env as Record<string, any>)[cfEmailBindingName],
            bindingName: cfEmailBindingName,
        } : undefined, this.settings.email.mock) : null
        if(this.email) this.extensions.push(this.email)

        // this.notify = new NotifyClient({}, this.email)

        // if (!jwtSecret()?.length) throw new HTTPException(500, {message: 'Invalid configuration - jwt secret is required'})
        this.adminJwtSecret = this.c.env.ADMIN_JWT_SECRET ? this.secretResolver.resolver('$ADMIN_JWT_SECRET', false) : async ()=>''

        this.jwt = new JWTTokenHelper(this.settings.jwtSecret, this.settings.jwtIssuer, this.settings.jwtAlgorithm, this.resolveAuthProviders(), this.secretResolver)
    }

    /**
     * Register a $DBExtension and fire its optional `init()` hook.
     * Preferred over direct `db.extensions.push(ext)` — the extension may wire
     * itself into the database (e.g., an adapter extension registering a
     * delegate into DefaultDatabaseAdapter) during init.
     *
     * Returns the extension for convenient one-liner use.
     */
    async registerExtension<E extends $DBExtension<T>>(ext: E): Promise<E> {
        this.extensions.push(ext)
        await ext.init?.()
        return ext
    }

    /** Merge authProviders with deprecated jwtAllowedIssuers into a single AuthProvider[] */
    private resolveAuthProviders(): AuthProvider[] | undefined {
        const providers: AuthProvider[] = [...(this.settings.authProviders ?? [])]

        // Migrate deprecated jwtAllowedIssuers → AuthProvider[]
        if (this.settings.jwtAllowedIssuers) {
            for (const issuer of this.settings.jwtAllowedIssuers) {
                if (typeof issuer === 'string') {
                    providers.push({ issuer })
                } else {
                    providers.push({ ...issuer })
                }
            }
        }

        return providers.length > 0 ? providers : undefined
    }

    // setup db etc
    async setup() {
        if(!this.auth.superadmin) throw new HTTPException(this.auth.uid ? 403 : 401, {message: 'Unauthorized, only superadmin can setup database'})
        const version = 0
        // Thunk form so sync throws from a setup call land in the same catch as async rejections.
        const tag = <V>(source: string, thunk: () => Promise<V> | V): Promise<V> =>
            Promise.resolve().then(thunk).catch((e: unknown) => {
                if (e instanceof HTTPException) {
                    throw new HTTPException(e.status, {message: `[setup:${source}] ${e.message}`})
                }
                const msg = e instanceof Error ? e.message : String(e)
                throw new HTTPException(500, {message: `[setup:${source}] ${msg}`})
            })
        const results = await Promise.all<Omit<DBMigration, 'id'> | null | void | $Table<T>>([
            tag('kv', () => this.kv.setup(version)),
            tag('identities', () => this.identities?.setup(version) ?? null),
            ...this.extensions.map(e => tag(`extension:${e.constructor.name}`, () => e.setup ? e.setup(version) : null)),
            ...this.settings.tables.map(t => tag(`table:${t.name}`, () => this.table(t.name).setup(version)))
        ])
        const infraEntries = results.filter(
            (r): r is Omit<DBMigration, 'id'> =>
                !!r && typeof r === 'object' && 'name' in r && 'sql' in r
        )
        if (infraEntries.length) {
            const helper = this.extensions.find(e => e instanceof MigrationHelper) as MigrationHelper | undefined
            if (helper) {
                try {
                    await helper.apply(infraEntries)
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e)
                    throw new HTTPException(500, {message: `[setup:record-infra] Infra tables created but recording into _db_migrations failed: ${msg}. Retry Setup — idempotent.`})
                }
            }
        }
        const settings = await this.kv.get('$settings')
        let message = 'Success'
        if(!settings) {
            message = 'Migrations not run yet - $settings not found - Run migrations to update $settings in the db'
        } else {
            const settings2 = JSON.parse(settings)
            if (settings2.version !== this.settings.version)
                message = `Settings version mismatch - ${settings2.version} !== ${this.settings.version} - deploy the worker again with the latest settings`
        }
        return message
    }

    // region auth

    async initAuth(tok?: string|false) {
        // console.log('c auth 2 ', this.c.get('auth'))
        if (this.c.get('auth')?.uid) {
            // this.auth = this.c.get('auth')
            // console.log('preset auth', this.auth)
            return
        }
        if(!tok) {
            // request header bearer. This takes priority over extensions. Extensions should call initAuth manually if required
            if(!tok) {
                const auth = this.c.req.header('Authorization') ?? this.c.req.header('X-Authorization')
                const isBearer = auth && auth.startsWith('Bearer ')
                tok = auth ? isBearer ? auth.slice(7) : auth : ''
            }

            if (!tok && this.settings.authCookie?.name) {
                tok = getCookie(this.c, this.settings.authCookie.name) || ''
            }

            if (!tok) {
                for (const extension of this.extensions) {
                    if (extension.getAuthToken) tok = await extension.getAuthToken()
                    if (tok) break
                }
            }

            if (!tok) return
            // if(!isBearer) {
            //     // console.log('auth header not bearer', tok)
            //     return
            // }
        }

        let jwtSecret = this.adminJwtSecret

        const adminToken = await this.adminServiceToken()
        if (adminToken && tok === adminToken) { // todo timingSafeEqual here? not really required
            tok = await this.generateAdminToken("superadmin", tok)
        }
        // console.log('init', tok)

        let payload = null as JWTPayloadOp | null
        try {
            payload = typeof tok === 'string' ? decode(tok).payload as JWTPayloadOp | null : null
        } catch (e) {
        }
        if (!payload) return

        // Check bearerMode before verification — use original iss from unverified payload
        // (some providers like Google rewrite iss during verification)
        const originalIss = payload.iss
        if (this.jwt.getBearerMode(originalIss) === 'login') return

        if (payload.cid) {
            const table = this.settings.tables.find(t => t.name === payload!.cid)
            if (!table) throw new HTTPException(400, {message: 'Invalid auth table'})
            const auth = table.extensions.find(e => e.name === "auth") as TableAuthExtensionData
            jwtSecret = this.secretResolver.resolver(auth.jwtSecret, true, `JWT_SECRET for ${table.name}`)
        }

        // console.log('init', payload, secret)
        payload = await this.jwt.decodeAuth(tok!, await jwtSecret(), false, undefined, payload).catch(e => {
            console.error(e)
            return null
        })
        // console.log('init', payload)

        if (!payload) return

        const aud = Array.isArray(payload.aud) ? (payload.aud.length === 1 ? payload.aud[0] : payload.aud) : payload.aud
        this.auth = {
            uid: payload.id ?? null,
            cid: payload.cid, // table id
            sid: payload.sid ?? null, // session id
            email: payload.verified ? payload.sub : '',
            jwt: payload,
            role: aud ?? null,
            verified: Boolean(payload.verified ?? false),
            meta: payload.meta ?? {},
            admin: Boolean(payload.admin ?? false),
            superadmin: false,
        } satisfies AuthContext

        // todo
        if (this.auth.cid && this.auth.admin) {
            throw new HTTPException(401, {message: 'Unauthorized'})
        }
        if(this.auth.admin){
            const role = Array.isArray(this.auth.role) ? this.auth.role : [this.auth.role]
            const viewer = role.includes('viewer')
            const editor = role.includes('editor') || role.includes('admin')
            const superadmin = role.includes('superadmin')
            if(!editor && !superadmin) this.readOnlyMode = true
            if(!viewer && !editor && !superadmin) this.dryRunMode = true
            if(superadmin) this.auth.superadmin = true
        }
        this.c.set('auth', this.auth)
    }

    /**
     * The `ADMIN_SERVICE_TOKEN` secret, or '' when it is not set. An empty value or the placeholder `not-set`
     * counts as not set, so a deployment that keeps the placeholder never accepts `Bearer not-set` as superadmin.
     * A value shorter than 12 characters still works but logs an error (once per isolate): it grants superadmin.
     */
    async adminServiceToken(): Promise<string> {
        const token = (await this.secretResolver.resolve('$ADMIN_SERVICE_TOKEN')).trim()
        if (!token || token.toLowerCase() === 'not-set') return ''
        if (token.length < 12 && !shortAdminTokenLogged) {
            shortAdminTokenLogged = true
            console.error('ADMIN_SERVICE_TOKEN is shorter than 12 characters. It grants superadmin access: set a long random value (for example `openssl rand -hex 32`).')
        }
        return token
    }

    async generateAdminToken(role: string, tok?: string) {
        const adminToken = await this.adminServiceToken()
        if(!this.auth.superadmin && (!adminToken || tok !== adminToken)) throw new HTTPException(401, {message: 'Unauthorized'})
        const adminJwtSecret = await this.adminJwtSecret()
        if (!adminJwtSecret) throw new HTTPException(500, {message: 'Invalid configuration - ADMIN_JWT_SECRET not set'})
        const tokenDuration = 3 * 60 * 60 // 3 hours
        const data = {
            sub: role + '@' + this.settings.appUrl.trim().replace(/^https?:\/\//, ''),
            id: generateUid(),
            meta: {},
            aud: role,
            verified: true,
            admin: true,
        }
        return await this.jwt.createJwtToken(data, adminJwtSecret, tokenDuration)
    }

    // endregion auth

    // region table

    table(name: string) {
        if (this.tables[name]) return this.tables[name]
        const tableData = this.settings.tables.find(t => t.name === name)
        if (!tableData) throw new HTTPException(404, {message: `Table not found - ${name}`})
        const globals = honoToJsep(this.c.req, this.auth)
        const jc = createJsepContext(tableData.name, this.settings.tables, globals, [tableData.name])
        const table = new $Table(tableData, jc, this).initialize()
        this.tables[name] = table
        return table
    }

    allTables(){
        const keys = this.settings.tables.map(t=>t.name)
        return keys.map(k=>this.table(k))
    }

    // endregion table

    // region route

    readonly _apiBase = '/api'
    readonly apiBase = this._apiBase + '/v1'
    readonly apiTableSuffix = '/table'
    readonly apiTableBase = this.apiBase + this.apiTableSuffix

    // routePath: string | null = null
    async route(path: string){
        if(!path.startsWith(this._apiBase+'/')) return undefined
        // const lastPath = this.routePath
        // this.routePath = path

        await this.initAuth() // load from bearer auth header

        let res
        if(path.startsWith(this.apiTableBase+'/')) {
            const p = path.replace(this.apiTableBase, '').split('/')
            const table = this.table(p[1]) // starts with /
            res = await table.route('/'+p.slice(2).join('/'))
        } else if(path.startsWith(this.apiBase))
            res = await this._route(path.replace(this.apiBase, ''))
        else res = undefined

        // this.routePath = lastPath

        // todo check if response headers are immutable?
        if(res && res.headers){
            const fsStats = Object.entries(this._fsStats)
            const uploaded = fsStats.filter(f=>f[1] !== null).map(f=>[f[0], f[1]])
            const deleted = fsStats.filter(f=>f[1] === null).map(f=>f[0])
            // todo magic strings
            // todo only send headers if set in config/wrangler? (currently only used in tests)
            if(uploaded.length) res.headers.set('x-uploaded-files', JSON.stringify(Object.fromEntries(uploaded)))
            if(deleted.length) res.headers.set('x-deleted-files', JSON.stringify(deleted))
        }

        return res
    }

    get requestMethod(){
        return this.c.req.method
    }
    private requestBody?: Record<string, any> | null
    async getRequestBody(){
        if(this.requestBody === undefined) this.requestBody = await parseRequestBody(this.c.req)
        return this.requestBody
    }

    rawRouteHandler(route: HttpRoute): RawRouterHandlerFunction{
        return async(params, path)=>{
            if(typeof route.handler === 'function') {
                const data = await this.getRequestBody()
                const res = await route.handler(data??{}, params, path)
                if (!res) throw new ProcessError('Not found', 404)
                if(typeof res === 'string') return this.c.render(res) // todo set jsx renderer or something by default?
                return this.c.json(res)
            }else {
                return route.handler.raw(params, path)
            }
        }
    }

    getRoutes(){
        this._initRoutes()
        return this.routes
    }
    // endregion route

    // region crud

    rawDelete<T1 = any, TRet = T1[]>(
        table: $Table, query: OptionalOmit<DeleteQuery, 'table'>,
        fileFields?: string[],
        then?: (r:T1[])=>TRet
    ){
        if(this.readOnlyMode) throw new ProcessError('DELETE not allowed in read only mode')

        if((query as DeleteQuery).table && (query as DeleteQuery).table !== table.jc.tableName && columnify((query as DeleteQuery).table) !== table.jc.tableName) throw new ProcessError('Invalid table')

        const ret = this._fileFieldsToReturning(table, fileFields, true)
        if(ret.length) {
            if (!query.returning) query.returning = []
            query.returning.push(...ret)
        }

        const deleteQuery = {...query, table: table.jc.tableName}
        const sql = buildDeleteQuery(deleteQuery, table.jc.autoSimplifyExpr)

        return this.prepare<T1, TRet, 'delete'>({
            table,
            type: 'delete',
            crudQuery: deleteQuery,
            query: sql,
            errorMessage: 'Failed to run delete query',
            onRun: async ()=>{
                // todo make beforeDelete
            },
            onError: async (e) => {
                // ignoring error on fail. todo
                return e
            },
            onSuccess: async (r) => {
                // todo make onDelete
                // if(filesToDelete && table.autoDeleteR2Files){
                //     await this._deleteFiles(filesToDelete, table).catch(()=>{})
                // }
                await this._cleanupFilesToUpload(r.results, undefined, table)
            },
            then,
        })
    }

    rawInsert<T1 = any, TRet=T1[]>(
        table: $Table, query: OptionalOmit<InsertQuery, 'table'>,
        filesToUpload?: Record<string, File>, filesToRef?: string[],
        fileFields?: string[], // fields that are files, so we can check if they are uploaded
        then?: (r:T1[])=>TRet
    ){
        if(this.readOnlyMode) throw new ProcessError('INSERT not allowed in read only mode')

        if((query as InsertQuery).table && (query as InsertQuery).table !== table.jc.tableName && columnify((query as InsertQuery).table) !== table.jc.tableName) throw new ProcessError('Invalid table')

        // get updated file fields back as returning
        const ret = this._fileFieldsToReturning(table, fileFields, false)
        if(ret.length) {
            if (!query.returning) query.returning = []
            query.returning.push(...ret)
        }
        // todo if there is replace clause, we need to find the old file fields that are being replaced and return them
        if(fileFields?.length && query.or?.trim().toUpperCase().includes('REPLACE')){
            throw new ProcessError('Cannot use file fields with INSERT OR REPLACE at the moment', 400)
        }
        const sqlQs: [InsertQuery, SQLQuery][] = []
        if(Array.isArray(query.values)){
            // D1 has SQLITE_MAX_COMPOUND_SELECT of 5
            // https://github.com/cloudflare/workerd/blob/c3a0749df92ea56a362c2c132fe09fb69e0f92cd/src/workerd/util/sqlite.c%2B%2B#L1070
            // because - https://sqlite.org/security.html

            const batchSize = 5
            for (let i = 0; i < query.values.length; i += batchSize) {
                const batch = query.values.slice(i, i + batchSize)
                const insertQuery = {...query, values: batch, table: table.jc.tableName}
                const sql = buildInsertQuery(insertQuery, table.jc.autoSimplifyExpr, true, table.redactedFields)
                sqlQs.push([insertQuery, sql])
            }
        }else {
            const insertQuery = {...query, table: table.jc.tableName}
            const sql = buildInsertQuery(insertQuery, table.jc.autoSimplifyExpr, true, table.redactedFields)
            sqlQs.push([insertQuery, sql])
        }
        // const sql = buildInsertQuery({...query, table: table.jc.tableName}, table.jc.autoSimplifyExpr)

        // todo since we are authenticating with rules, its possible an unauthenticated user can DOS by putting in loop upload and delete files

        const onRun = async ()=>{
            // todo - make beforeInsert
            // will throw error on fail
            filesToRef && await this._refCheckFiles(filesToRef, table)
            filesToUpload && await this._uploadFiles(filesToUpload, table)
        }
        const onError = async (e: any) => {
            // todo - make onInsertFail
            // if error, delete uploaded files
            // _deleteFiles logs its own failure; don't let it replace the error that got us here
            if(filesToUpload) await this._deleteFiles(Object.keys(filesToUpload), table).catch(()=>{})
            return e
        }
        const onSuccess = async (r: T1[]) => {
            // todo - make onInsert
            // clean up result to find inserted files and remove them from response
            if(filesToUpload) await this._cleanupFilesToUpload(r, filesToUpload, table)
        }

        if(sqlQs.length === 1) {
           return this.prepare<T1, TRet, 'insert'>({
                table, type: 'insert',
                crudQuery: sqlQs[0][0],
                query: sqlQs[0][1],
                errorMessage: 'Failed to run insert query',
                onRun,
                onError,
                onSuccess: async (r) => onSuccess(r.results),
                then,
            })
        }else {
            return this.transaction<T1, TRet, 'insert'>({
                table, type: sqlQs.map(_=>'insert'),
                crudQuery: sqlQs.map(q=>q[0]),
                query: sqlQs.map(q=>q[1]),
                errorMessage: 'Failed to run insert query',
                onRun,
                onError,
                onSuccess: async (r) => onSuccess(r.flat()),
                // @ts-ignore
                then: async (r)=> then ? then(r.flat()) : r.flat(),
            })
        }

    }

    rawUpdate<T1 = any, TRet = T1[]>(
        table: $Table, query: OptionalOmit<UpdateQuery, 'table'>,
        filesToUpload?: Record<string, File>, filesToRef?: string[], filesToDelete?: string[],
        fileFields?: string[], // fields that are files, so we can check if they are uploaded
        then?: (r:T1[])=>TRet
    ){
        if(this.readOnlyMode) throw new ProcessError('UPDATE not allowed in read only mode')

        if((query as UpdateQuery).table && (query as UpdateQuery).table !== table.jc.tableName && columnify((query as UpdateQuery).table) !== table.jc.tableName) throw new ProcessError('Invalid table')

        // get updated file fields back as returning
        const ret = this._fileFieldsToReturning(table, fileFields, false)
        if(ret.length) {
            if (!query.returning) query.returning = []
            query.returning.push(...ret)
        }
        const oldReturning = this._fileFieldsToReturning(table, fileFields, true)

        const selectQuery = {
            where: query.where,
            from: table.jc.tableName,
            selects: oldReturning,
            params: query.params
        }
        const sqlSelect = oldReturning.length ? buildSelectQuery(selectQuery, table.jc.autoSimplifyExpr) : null

        const updateQuery = {...query, table: table.jc.tableName}
        const sql = buildUpdateQuery(updateQuery, table.jc.autoSimplifyExpr, true, table.redactedFields/*, oldReturning*/)

        const onRun = async ()=>{
            // todo - make beforeUpdate
            // will throw error on fail
            filesToRef && await this._refCheckFiles(filesToRef, table)
            filesToUpload && await this._uploadFiles(filesToUpload, table)
        }
        const onError = async (e: any) => {
            // todo - make onUpdateFail
            // if error, delete uploaded files
            // TODO: its possible that some rows are not inserted because of where/rule in sql. those files need to be deleted. same in update and delete. we need to add a force returning clause with id? or can we use some other metadata
            // _deleteFiles logs its own failure; don't let it replace the error that got us here
            if(filesToUpload) await this._deleteFiles(Object.keys(filesToUpload), table).catch(()=>{})
            return e
        }
        const onSuccess = async (r: T1[], old?: any[])=>{
            // todo - make onUpdate
            // ignore error on fail
            // if(filesToDelete && table.autoDeleteR2Files){
            //     await this._deleteFiles(filesToDelete, table).catch(()=>{})
            // }
           await this._cleanupFilesToUpload(r, filesToUpload, table, old)
        }

        return !sqlSelect ? this.prepare<T1, TRet, 'update'>({
            table, type: 'update',
            crudQuery: updateQuery,
            query: sql,
            errorMessage: 'Failed to run update query',
            onRun,
            onError,
            onSuccess: (r) => onSuccess(r.results),
            then,
        }) : this.transaction<T1, TRet, 'update'|'select'>({
            table, type: ['update', 'select'],
            crudQuery: [selectQuery, updateQuery],
            query: [sqlSelect, sql],
            errorMessage: 'Failed to run update query',
            onRun,
            onError,
            onSuccess: async (r) => {
                // console.log('update success', r)
                return onSuccess(r[1], r[0])
            },
            then: async (r)=> {
                const res = r[1]
                return then ? then(res) : res as TRet
            },
        })
    }

    rawSelect<T=any, TRet=T[]>(table: $Table, query: OptionalOmit<SelectQuery, 'from'>, then?: (r:T[])=>TRet): D1PreparedQuery<T, T[], 'select'>|null
    rawSelect<T=any>(table: $Table, query: OptionalOmit<SelectQuery, 'from'>, countTotal: boolean): D1PreparedQuery<T, { items: T[], total: number }, 'select'>|null
    rawSelect<T=any, TRet=T[]>(table: $Table, query: OptionalOmit<SelectQuery, 'from'>, countTotal?: (boolean|((r:T[])=>TRet))){
        let qFrom = (query as SelectQuery).from
        if(qFrom && (typeof qFrom !== 'string' || ((qFrom as any) !== table.jc.tableName && columnify(qFrom as any) !== table.jc.tableName))) throw new ProcessError('Invalid from table')
        const selectQuery = {...query, from: table.jc.tableName}
        const sql = buildSelectQuery(selectQuery, table.jc.autoSimplifyExpr)
        // console.log(query, sql)

        if(!countTotal || typeof countTotal === 'function') {
            return countTotal === undefined || typeof countTotal === 'function' ?
                this.prepare<T, TRet, 'select'>({
                    table, type: 'select', crudQuery: selectQuery, query: sql,
                    errorMessage: 'Failed to run select query',
                    then: countTotal
                }) :
                this.prepare<T, {items: T[], total: number}, 'select'>({
                    table, type: 'select', crudQuery: selectQuery, query: sql,
                    errorMessage: 'Failed to run select query',
                    then: async (res)=> ({items: res, total: -1})
                })
        }

        const countField = table.mapping.uid ? ident(table.mapping.uid, table.jc) : '*'
        // const countField = table.mapping.uid ? `DISTINCT ${table.data.name}.${columnify(table.mapping.uid)}` : '*'

        const countSelectQuery = {
            ...query,
            from: table.jc.tableName,
            selects: [`count(${countField}) as total`],
            limit: undefined,
            offset: undefined,
            orderBy: undefined,
            groupBy: undefined,
            distinct: false,
        }
        const countQuery = buildSelectQuery(countSelectQuery, table.jc.autoSimplifyExpr)

        return this.transaction<T, {items: T[], total: number}, 'select'>({
            table, type: ['select', 'select'],
            crudQuery: [selectQuery, countSelectQuery],
            query: [sql, countQuery],
            errorMessage: 'Failed to run select query',
            then: async (r)=> ({items: r[0], total: (r[1][0] as any)?.total ?? -1})
        })
    }

    // endregion crud

    // region sql

    // async sql<T>(d1Expr: D1Query, c?: SQLRunContext) {
    //     return await this.rawSQL<T>(d1Expr, c).run()
    // }
    // async sqlTransaction<T>(d1Expr: D1Query[], c?: SQLRunTransactionContext) {
    //     return await this.rawSQLTransaction<T>(d1Expr, c).run()
    // }

    /**
     * Run a named action programmatically. Same as `POST /api/v1/action/{name}` but without an HTTP round-trip.
     * @param name - Action name as defined in `actions` config
     * @param body - Parameters matching the action's `params` definition
     * @returns Array of result arrays (one per query in the action), or undefined in dry-run mode
     */
    async runAction<T = any>(name: string, body: Record<string, any>): Promise<T[][] | null | undefined> {
        return (await this._runAction(name, body))?.run()
    }
    private async _runAction(name: string, body: Record<string, any>){
        const action = this.settings.actions?.find(a=>a.name === name)
        if(!action) throw new ProcessError(`Action not found - ${name}`, 404)

        // Auth check
        if(action.requireAuth && !this.auth.uid)
            throw new ProcessError('Authentication required', 401)

        if(this.dryRunMode || envBool(this.c.env.RESPOND_WITH_QUERY_LOG))
            this.queryLog.push('ACTION: ' + action.name)
        if(this.dryRunMode) return

        // Build Zod schema from param definitions and validate
        const paramDefs = action.params ?? {}
        const shape: Record<string, z.ZodTypeAny> = {}
        for (const [paramName, paramDef] of Object.entries(paramDefs)) {
            const def = typeof paramDef === 'string' ? {type: paramDef} : paramDef
            let base: z.ZodTypeAny
            switch(def.type) {
                case 'string': base = z.string(); break
                case 'number': base = z.number(); break
                case 'integer': base = z.number().int(); break
                case 'boolean': base = z.boolean(); break
            }
            if(def.optional) {
                base = def.default !== undefined ? base.optional().default(def.default as any) : base.optional()
            }
            shape[paramName] = base
        }
        const paramsSchema = z.object(shape).strict()
        const paramsBody = zParseWithPath(paramsSchema, body, ['action', name, 'params']) as Record<string, any>

        const prepared: (D1PreparedQuery<any, any, QueryType>|D1PreparedTransaction<any, any, QueryType>)[] = []

        // Guard check — evaluated once before any steps/sql
        if(action.guard) {
            const guardPrep = this._evaluateActionGuard(action.guard, paramsBody)
            if(guardPrep) prepared.push(guardPrep)
            // If guard was resolved via JS (Layer 1), guardPrep is undefined (method returned early)
        }

        const applyTableRules = action.applyTableRules ?? true
        const sqlEntries = Array.isArray(action.sql) ? action.sql : action.sql ? [action.sql] : []
        const steps = Array.isArray(action.steps) ? action.steps : action.steps ? [action.steps] : []

        if(!sqlEntries.length && !steps.length) throw new ProcessError(`Action ${name}: must have sql or steps`, 500)
        if(sqlEntries.length && steps.length) throw new ProcessError(`Action ${name}: cannot have both sql and steps`, 500)

        // SQL mode (raw query objects) — always bypasses table rules (uses $Database.rawXxx, not $Table hooks)
        if(sqlEntries.length){
            for (const query1 of sqlEntries) {
                if(!query1) throw new ProcessError(`Action ${name}: invalid null entry in sql array`, 500)
                const query = structuredClone(query1) as any
                query.params = {...query.params, ...paramsBody}

                const tableName = query.table || query.from
                if(!tableName) throw new ProcessError(`Action ${name}: missing table in sql entry`, 500)
                const table = this.table(Array.isArray(tableName) ? tableName[0] : tableName)

                // Sensitive field filtering: expand returning: ['*'] to exclude noSelect fields
                if(query.returning) query.returning = this._expandReturningWildcard(table, Array.isArray(query.returning) ? query.returning : [query.returning])

                let prep
                if(query.type === 'SELECT'){
                    if(Array.isArray(query.from)) throw new ProcessError(`Action ${name}: cannot have multiple tables in select query`, 500)
                    prep = this.rawSelect(table, query)
                }else if(query.type === 'UPDATE'){
                    prep = this.rawUpdate(table, query)
                }else if(query.type === 'INSERT'){
                    prep = this.rawInsert(table, query)
                }else if(query.type === 'DELETE'){
                    prep = this.rawDelete(table, query)
                }else{
                    throw new ProcessError(`Action ${name}: unsupported query type: ${(query as any).type}`, 500)
                }
                if(!prep) throw new ProcessError(`Action ${name}: failed to prepare sql entry`, 500)
                prepared.push(prep)
            }
        }

        // Steps mode (expression-based statements)
        if(steps.length){
            const skipRules = !applyTableRules
            for (const step of steps) {
                if(!step) throw new ProcessError(`Action ${name}: invalid null entry in steps array`, 500)
                const table = this.table(step.table)
                const savedParams = table.jc.globals.params
                table.jc.globals.params = {...table.jc.globals.params, ...paramsBody}
                if(skipRules) table._skipRulesExtension = true

                try {
                    // todo why as typecase only required for one of them
                    let prep
                    if(step.type === 'SELECT'){
                        prep = await table.rawSelect(step)
                    }else if(step.type === 'UPDATE'){
                        prep = await table.rawUpdate(step)
                    }else if(step.type === 'INSERT'){
                        prep = await table.rawInsert(step as TableInsertParams)
                    }else if(step.type === 'DELETE'){
                        prep = await table.rawDelete(step)
                    }else{
                        throw new ProcessError(`Action ${name}: unsupported step type: ${(step as any).type}`, 500)
                    }
                    if(!prep) throw new ProcessError(`Action ${name}: failed to prepare step`, 500)
                    prepared.push(prep)
                } finally {
                    table._skipRulesExtension = false
                    table.jc.globals.params = savedParams
                }
            }
        }

        if(!prepared.length) throw new ProcessError(`Action ${name}: no valid entries to execute`, 500)

        const res: D1PreparedTransaction<any, any[][], QueryType> = {
            prepared,
            c: undefined,
            run: async ()=>this._execBatch(res)
        }
        return res
    }

    /**
     * Evaluates an action guard expression. Two-layer approach:
     * Layer 1 (JS): If expression fully simplifies to a literal (e.g., auth.uid != null), evaluate immediately.
     * Layer 2 (SQL): If expression uses SQLite functions (e.g., unixepoch()), build a guard SQL statement
     *   that is prepended to the D1 batch. Uses json('') trick to throw on failure.
     * Column references are rejected — guard context has no table columns.
     */
    private _evaluateActionGuard(guard: string, params: Record<string, any>): D1PreparedQuery | undefined {
        const globals = honoToJsep(this.c.req, this.auth)
        globals.params = params
        const jc = createJsepContext('_guard', this.settings.tables, globals, [])

        const result = parseRuleQuery(jc, guard)

        // Layer 1: JS evaluation — expression fully simplified to a literal
        if('l' in result) {
            if(!result.l) throw new ProcessError('Forbidden', 403)
            return // guard passed, no SQL needed
        }

        // Layer 2: SQL guard — expression uses SQLite functions (unixepoch, etc.)
        // json('1') succeeds, json('') throws "malformed JSON" → D1 batch aborts & rolls back
        const guardSql = result as SQLQuery
        const wrappedSql: SQLQuery = {
            q: `SELECT json(CASE WHEN (${guardSql.q}) THEN '1' ELSE '' END)`,
            p: guardSql.p,
        }
        const d1Query = sqlQueryToD1Query(wrappedSql)
        return this._prepareD1Query(d1Query, true, {
            type: 'select' as const,
            table: undefined as any,
            crudQuery: undefined as any,
            query: wrappedSql,
            errorMessage: 'Forbidden',
            onError: async () => { throw new ProcessError('Forbidden', 403) },
        })
    }

    /** Expands returning: ['*'] to explicit field names: noSelect fields only for admins, password hash/salt never */
    private _expandReturningWildcard(table: $Table, returning: string[]): string[] {
        const isAdmin = !!this.auth.admin
        return returning.flatMap(r => {
            if(r !== '*') return [r]
            return Object.entries(table.fields)
                .filter(([_, f]) => isFieldSelectable(f, isAdmin))
                .map(([name]) => name)
        })
    }

    // endregion sql

    // region r2/s3 helpers, todo make private?

    private _fsStats: Record<string, string|null> = {} // key is the uploaded file name, value is the source file name if uploaded or null if deleted

    async headFileObject(key: string){
        if(this.dryRunMode || envBool(this.c.env.RESPOND_WITH_QUERY_LOG))
            this.queryLog.push('STORAGE: headFileObject: ' + key)
        if(this.dryRunMode) throw new Error('headFile not supported in dry run mode')
        // this._fsStats.push(['head', key])
        return this.bucket.head(key)
    }

    // todo need to keep types in sync with cloudflare, enforce it someway in ts so it errors when cloudflare changes something
    getFileObject(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
    async getFileObject(key: string, options?: R2GetOptions & {
        onlyIf: R2Conditional | Headers;
    }): Promise<R2ObjectBody | R2Object | null>{
        if(this.dryRunMode || envBool(this.c.env.RESPOND_WITH_QUERY_LOG))
            this.queryLog.push('STORAGE: getFileObject: ' + key)
        if(this.dryRunMode) throw new Error('getFile not supported in dry run mode')
        return this.bucket.get(key, options)
    }

    private async putFileObject(
        key: string,
        value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
        options?: R2PutOptions & {
            onlyIf?: R2Conditional | Headers;
        },
    ): Promise<R2Object | null | {dummy: true}>{
        if(this.dryRunMode || envBool(this.c.env.RESPOND_WITH_QUERY_LOG))
            this.queryLog.push('STORAGE: putFileObject: ' + key) // todo add data about file?
        if(this.dryRunMode) return {dummy: true}
        if(this.readOnlyMode) throw new Error('putFile not allowed in read only mode')
        // The bucket can be a Workers RPC stub (e.g. to R2RestRPC in another worker). The RPC
        // serializer refuses File and Blob ("Could not serialize object of type File") and caps
        // other values at 32 MiB, so send the bytes as a stream with its size via putStream. Only
        // buckets that implement it get this: an RPC stub answers any method name and
        // R2RestAdapter has the method, while a native R2Bucket has no putStream and keeps taking
        // the File as-is, without a copy.
        const bucket = this.bucket as R2Bucket & {putStream?: (key: string, stream: ReadableStream, size: number, options?: R2PutOptions) => Promise<R2Object>}
        const put = typeof Blob !== 'undefined' && value instanceof Blob && typeof bucket.putStream === 'function'
            ? bucket.putStream(key, value.stream(), value.size, options)
            : bucket.put(key, value, options)
        return put.then(r=>{
            const id = !value ? 'empty' :
                typeof value === 'string' ? value.substring(0, 10) :
                (value as File).name ? (value as File).name :
                        value instanceof ArrayBuffer ? 'arraybuffer' :
                            (typeof value === 'object' && 'getReader' in value && 'locked' in value) ? 'stream' :
                            'data'
            this._fsStats[key] = id
            return r
        })
    }

    private async deleteFileObject(keys: string | string[]){
        if(this.dryRunMode || envBool(this.c.env.RESPOND_WITH_QUERY_LOG))
            this.queryLog.push('STORAGE: deleteFileObject: ' + keys)
        if(this.dryRunMode) return
        if(this.readOnlyMode) throw new Error('deleteFile not allowed in read only mode')
        return this.bucket.delete(keys).then(r=>{
            const keys1 = Array.isArray(keys) ? keys : [keys]
            for (const key of keys1) {
                if(typeof this._fsStats[key] === 'string')
                    delete this._fsStats[key] // file was uploaded then deleted, so remove from stats
                else
                    this._fsStats[key] = null
            }
            return r
        })
    }

    // endregion r2/s3

    // region private sql

    private prepare<T, TRet = T[], TC extends QueryType = QueryType>(c: SQLRunContext<T, TRet, TC>) {
        const q = c.query
        // console.log(logSQLQuery(q))
        if (this.dryRunMode || envBool(this.c.env.RESPOND_WITH_QUERY_LOG)) {
            this.queryLog.push(logSQLQuery(q))
        }
        const d1Expr = sqlQueryToD1Query(q)
        // return await runD1Query<T>(this.d1, d1Expr, err)
        if(this.dryRunMode) return null // todo add dummy data?
        return this._prepareD1Query(d1Expr, q._readOnly, c)
    }
    private transaction<T, TRet = T[][], TC extends QueryType = QueryType>(c: SQLRunTransactionContext<T, TRet, TC>) {
        const q = c.query
        // console.log(q.map(q1 => logSQLQuery(q1)).join(';\n'))
        if (this.dryRunMode || envBool(this.c.env.RESPOND_WITH_QUERY_LOG)) {
            this.queryLog.push(q.map(q1 => logSQLQuery(q1)).join(';\n'))
        }
        const d1Expr = q.map(sqlQueryToD1Query)
        // return await runD1Transaction(this.d1, d1Expr, err)
        if(this.dryRunMode) return null // todo add dummy data?
        return this._prepareD1Transaction(d1Expr, q.every(q1=>q1._readOnly), c)
    }

    // private async _rawSQL<T>(d1Expr: D1Query, onErr?: (er: any) => any, readOnly = false, c?: SQLRunContext) {
    //     return this._prepareD1Query(d1Expr, onErr, readOnly, c)
    // }

    // endregion private sql

    // region private r2/s3

    private readonly storage?: R2Bucket

    private get bucket() {
        if (!this.storage) throw new HTTPException(500, {message: 'No bucket provided'});
        return this.storage
    }

    /**
     * Checks that all files referenced in a query exist
     * @param files
     * @param table
     * @protected
     */
    protected async _refCheckFiles(files: string[], table: $Table){
        if(!files.length) return

        // todo add support for dry run mode, it would fail if allowMultipleFileRef is true
        if(!table.allowMultipleFileRef) throw new ProcessError('Multiple file references shouldn\'t be allowed')
        // console.log('Checking files', files)
        if(this.c.req.header('x-check-file-references') === 'false') return

        // todo check files length, max subrequest allowed is 1000, but it was failing with around 700 also
        if(files.length > 500) throw new ProcessError('Too many files to check, set x-check-file-references to false to disable.')

        const promises = files.map(async (key)=>{
            const res = await this.headFileObject(table.fileKey(key)).catch(e=>{
                console.error('Failed to check file', e)
                return undefined
            })
            if(res === undefined) throw new ProcessError('Failed to check file ' + key)
            return res
        })
        const res = await Promise.allSettled(promises)
        const hasError = res.some(r=>r.status === 'rejected')
        const successful = res.filter(r=>r.status === 'fulfilled').map((r)=>r.value)
        if(!successful.length || hasError) {
            throw new ProcessError('Failed to check files')
        }
        if(successful.includes(null)){
            throw new ProcessError('File not found ' + files[successful.indexOf(null)])
        }
    }

    protected async _uploadFiles(files: Record<string, File>, table: $Table){
        const keys = Object.keys(files)
        if(!keys.length) return
        console.log('Uploading files', keys, files)
        const promises = keys.map(async (key)=>{
            const file = files[key]
            const fileKey = table.fileKey(key)
            const res = await this.putFileObject(fileKey, file, {
                httpMetadata: {
                    contentType: file.type || 'application/octet-stream',
                    cacheControl: 'public, max-age=31536000', // 1 year
                }
            }).catch(e=>{
                console.error('Failed to upload file', e)
                return null
            })
            if(!res) throw new ProcessError('Failed to upload file ' + key + ' ' + file.name )
            return res
        })
        const res = await Promise.allSettled(promises)
        const hasError = res.some(r=>r.status === 'rejected')
        const successful: R2Object[] = res.filter(r=>r.status === 'fulfilled').map((r: any)=>r.value)
        // any error, delete all files to stop/rollback the complete action
        if(hasError) {
            const errors = res.filter(r=>r.status === 'rejected').map((r: any)=>r.reason)
            console.error(errors)
            console.log('Deleting uploaded files', successful)
            await this.deleteFileObject(successful.map(r=>r.key)).catch(e=>{
                console.error('Unable to delete some files after upload error', e)
                // todo mark for delete somehow in logs?
            })
            throw new ProcessError('Failed to upload files' )
        }
    }

    protected async _deleteFiles(files: string[], table: $Table){
        const keys = files.map(f=>table.fileKey(f))
        if(!keys.length) return
        console.log('Deleting files', keys)
        return await this.deleteFileObject(keys).catch(e=>{
            console.error('Failed to delete files', keys, e)
            // todo mark for delete somehow in logs, since this error below will be ignored
            throw new Error('Failed to delete files')
        })
    }

    // todo remove old?
    private _fileFieldsToReturning(table: $Table, fileFields: string[] | undefined, old = false) {
        let r: {q: string, as: string}[] = []
        if (fileFields) for (const key of fileFields) {
            const id = (old ? '_0f_' : '_1f_') + Math.random().toString(36).substring(2, 15) // todo magic string, used also in $Database
            r.push({q: ident(key, table.jc), as: id})
        }
        return r
    }

    private async _cleanupFilesToUpload<T1>(r: T1[], filesToUpload: Record<string, File>|undefined, table: $Table, oldSelect?: any[]) {
        // delete files that are not referenced/inserted
        // get inserted files by all returning keys starting with _0file_
        const filesSuccess = [] as string[]
        const filesOld = [] as string[]
        for (const row of r as any[]) {
            const keys = Object.keys(row)
            for (const key of keys) {
                if (key.startsWith('_1f_')) {
                    // file was uploaded and inserted
                    const v = row[key]
                    if(v) filesSuccess.push(v)
                    delete row[key] // remove from row
                }
            }
            for (const key of keys) {
                if (key.startsWith('_0f_')) {
                    // previous value of the file
                    const v = row[key]
                    if(v && !filesSuccess.includes(v)) filesOld.push(v)
                    delete row[key] // remove from row
                }
            }
        }
        for (const row of oldSelect || []) {
            const keys = Object.keys(row)
            for (const key of keys) {
                if (key.startsWith('_0f_')) {
                    // previous value of the file
                    const v = row[key]
                    if(v && !filesSuccess.includes(v)) filesOld.push(v)
                    delete row[key] // remove from row
                }
            }
        }
        const failedFiles = !filesToUpload ? [] : Object.keys(filesToUpload).filter(f => !filesSuccess.includes(f))
        const filesToDelete = [...failedFiles]
        if(table.autoDeleteR2Files) filesToDelete.push(...filesOld)
        if(failedFiles.length) console.error(`Failed to insert files: ${failedFiles.join(', ')}`)
        if (filesToDelete.length) {
            // delete files that were not inserted
            await this._deleteFiles(filesToDelete, table).catch(() => {
                if(failedFiles.length) console.error(`Failed to delete files that were not inserted: ${failedFiles.join(', ')}`)
                if(filesOld.length) console.error(`Failed to delete files old files in db: ${filesOld.join(', ')}`)
            })
        }
    }

    // endregion private r2/s3

    // region routing

    // todo write tests for these routes
    private routes: HttpRoute[] = [{
        path: '/health',
        method: 'get',
        handler: async()=>{
            return {
                status: 'ok',
                timestamp: Date.now(),
                version: this.settings.version,
                appName: this.settings.appName,
            }
        },
        zod: ()=>({
            description: 'Health check endpoint to verify the server is running',
            request: {},
            responses: {
                '200': {
                    description: 'Server is healthy',
                    content: {'application/json': {
                        schema: z.object({
                            status: z.literal('ok'),
                            timestamp: z.number(),
                            version: z.number().optional(),
                            appName: z.string().optional(),
                        }),
                    }},
                }
            },
        }),
    }, {
        path: '/setup-db',
        method: 'post',
        handler: async()=>{
            const message = await this.setup()
            return {
                message, settings: this.settings,
            }
        },
        zod: ()=>({
            description: 'Setup database and get settings (create metadata tables etc)',
            request: {headers: z.object({authorization: z.string().min(1).max(255)}).describe('Admin Auth token with superadmin role')},
            responses: {
                '200': {
                    description: 'Success',
                    content: {'application/json': {
                            schema: databaseSettingsSchema,
                        }},
                }
            },
        }),
    }, {
        path: '/settings',
        method: 'get',
        handler: async()=>{
            if (!this.auth.admin) throw new HTTPException(this.auth.uid ? 403 : 401, {message: 'Unauthorized'})
            const isRaw = this.c.req.query('raw')
            if(isRaw !== undefined && (isRaw === '' || isRaw === 'true' || isRaw === '1'))
                return {tables: await getSQLiteSchema(this), jwtSecret: this.settings.jwtSecret, appUrl: this.settings.appUrl, version: 1} as DatabaseSettings
            return this.settings
        },
        zod: ()=>({
            description: 'Get database settings',
            request: {
                query: z.object({raw: z.boolean().optional().describe('Get raw sqlite schema (tableInfo)')}),
                headers: z.object({authorization: z.string().min(1).max(255)}).describe('Admin Auth token')
            },
            responses: {
                '200': {
                    description: 'Success',
                    content: {'application/json': {
                            schema: databaseSettingsSchema,
                        }},
                }
            },
        }),
    }, {
        path: '/files/:table/:rid/:path{.+}',
        method: 'get',
        handler: {raw: async(params)=>{
                // const token = this.c.req.query('token');
                // todo proper auth using pre-signed urls or auth token.
                const path = z.string().min(1).max(255).regex(/^[a-zA-Z0-9_\-\/.*+=#]+$/).parse(params!.path)
                const rid = z.string().min(1).max(255).parse(params!.rid)
                const table = this.table(params!.table)
                const object = await table.getFile(path, rid)
                // Not object.writeHttpMetadata(): over an RPC boundary (an RPC bucket binding) it
                // fills a copy of the Headers and the response goes out without content-type.
                const headers = new Headers(httpMetaToHeaders(object.httpMetadata));
                headers.set("etag", object.httpEtag);
                object.customMetadata && Object.entries(object.customMetadata).map(([k, v]) => headers.set('DDB-'+k, v))
                return this.c.newResponse(object.body, {headers})
            }},
        zod: ()=>({
            description: 'Get file from bucket that is referenced inside a record in a table',
            request: {
                params: z.object({table: z.string().min(1).max(255), rid: z.string().min(1).max(255).describe('Record id'), path: z.string().min(1).max(255).describe('File name/path')}),
                // query: z.object({token: z.string().min(1).max(255).optional().describe('Auth token')}),
            },
            responses: {
                '200': {description: 'Success'},
                '404': {description: 'Not found'},
            },
        }),
    }, {
        path: '/action/:name',
        method: 'post',
        handler: async(body, params)=>{
            if(!body || typeof body !== 'object' || Array.isArray(body)) throw new HTTPException(400, {message: 'Invalid request body'})
            const name = zParseWithPath(z.string().min(1).max(255).describe('Action name'), params.name, ['name'])
            const res = await (await this._runAction(name, body))?.run()
            return res ?? []
        },
        zod: ()=>({
            description: 'Run a named action',
            request: {
                params: z.object({name: z.string().min(1).max(255).describe('Action name')}),
                headers: z.object({authorization: z.string().min(1).max(255).optional()}).describe('Auth token'),
                body: {
                    description: 'Action parameters',
                    content: {'application/json': {schema: z.record(z.string(), z.any()).describe('Action parameters')}},
                    required: false,
                },
            },
            responses: {
                '200': {description: 'Success'},
                '401': {description: 'Authentication required'},
                '404': {description: 'Action not found'},
                '400': {description: 'Invalid parameters'},
            },
        }),
    }, {
        method: 'get',
        path: '/explain/*',
        handler: {
            raw: async (_params, path) => {
                if (!this.auth.admin || !envBool(this.c.env.RESPOND_WITH_QUERY_LOG)) throw new HTTPException(this.auth.uid ? 403 : 401, {message: 'Forbidden'})
                this.dryRunMode = true
                // todo this wont work with diff base route.
                path = path.replace('/explain', '')
                if(path.startsWith('/explain')) throw new Error('Cannot explain explain')
                if(!path.startsWith(this.apiTableSuffix)) throw new Error('Not supported for this path')
                const res = await this.route(this.apiBase + path)
                const logs = this.queryLog
                if(!res) return this.c.notFound()

                // NOTE - Don't do explain query plan here, the queries in the log can be unsafe.
                // if needed it can be done in the cli

                const resBody = await res.text().catch(e=>({error: e}))
                const resHeaders = {} as any
                res.headers.forEach((v, k)=>resHeaders[k] = v)
                return this.c.json({logs, result: res ? {
                    status: res.status,
                    body: resBody,
                    headers: resHeaders,
                } : null})
            },
        },
        zod: () => ({
            description: 'Explain route. Returns the list of sql statements and storage actions that will be executed',
            request: {
                params: z.object({route: z.string().min(1).max(255)}),
                headers: z.object({authorization: z.string().min(1).max(255)}).describe('Admin Auth token')},
            responses: {
                '200': {
                    description: 'Success',
                    content: {'application/json': {schema: z.object({
                        logs: z.array(z.string()),
                        result: z.object({status: z.number(), body: z.string(), headers: z.record(z.string(), z.string())}).optional(),
                    })}},
                },
            },
        })
    }, {
        path: '/auth/logout',
        method: 'post',
        handler: {raw: async () => {
            const cookieConfig = this.settings.authCookie
            if (cookieConfig) {
                deleteCookie(this.c, cookieConfig.name, {
                    path: cookieConfig.path ?? '/',
                    domain: cookieConfig.domain,
                })
            }
            return this.c.json({success: true})
        }},
        zod: () => ({
            description: 'Clear auth cookie',
            request: {},
            responses: {
                '200': {
                    description: 'Success',
                    content: {'application/json': {
                        schema: z.object({success: z.literal(true)}),
                    }},
                },
            },
        }),
    }]
    private router: LinearRouter<RawRouterHandlerFunction> | undefined
    protected _routesInit = false

    protected _initRoutes(){
        if(!this.router) this.router = new LinearRouter()
        if(this._routesInit) return this.router

        this.routes.push(
            ...this.extensions.flatMap(e=>e.routes),
        )

        for (const route of this.routes) {
            this.router.add(route.method.toUpperCase(), route.path, this.rawRouteHandler(route))
        }
        this._routesInit = true
        return this.router
    }
    private async _route(path: string){
        const router = this._initRoutes()
        const match = router.match(this.requestMethod, path)
        const [handler, params] = match[0]?.[0] ?? [undefined]
        if(!handler) return undefined
        return await handler(params as Record<string, string>, path)
    }

    // endregion routing
}


// export type NotifyModes = 'email'|'discord'/*|'slack'|'webhook'*/
// export class NotifyClient{
//     constructor(private props: {}, private email: EmailSendClient<any>|null) {
//     }
//
//     send(mode: NotifyModes){
//
//     }
// }
