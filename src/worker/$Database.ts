import {$Table} from './$Table'
import {Context} from 'hono'
import {HTTPException} from 'hono/http-exception'
import {decode} from '@tsndr/cloudflare-worker-jwt'
import {D1Error, ProcessError} from './util/error'
import {AuthContext} from '../types/env'
import {DatabaseSettings, databaseSettingsSchema} from '../types/config'
import {JWTTokenHelper} from '../security/JWTTokenHelper'
import {EmailSendClient} from './email/send-email'
import {InternalKV} from './internalKV'
import {$Env} from './env'
import {JWTPayloadOp} from '../types/jwt'
import {TableAuthExtensionData} from '../types/tableExtensions'
import {createJsepContext} from '../sql/parse/jsep'
import {logSQLQuery} from '../sql/build/query'
import {sqlQueryToD1Query} from '../sql/build/d1'
import {z} from 'zod'
import {D1PreparedStatement} from '@cloudflare/workers-types/2023-07-01/index'
import {MigrationHelper} from './migrationHelper'
import {LinearRouter} from 'hono/router/linear-router'
import {parseRequestBody} from './util/parseRequestBody'
import {HttpRoute, RawRouterHandlerFunction} from '../types/route'
import {$DBExtension} from './$DBExtension'
import {SQLQuery} from '../types/sql'

export class $Database<T extends $Env = $Env>{
    protected readonly tables: Record<string, $Table<T>> = {}
    readonly settings: DatabaseSettings
    auth: AuthContext = {
        jwt: {}, verified: false, admin: false,
        uid: null, role: null, email: null,
        meta: {}, cid: null
    }
    readonly queryLog: string[] = []

    readonly email: EmailSendClient | null
    jwt: JWTTokenHelper
    kv: InternalKV
    extensions: $DBExtension[] = []

    readonly database: D1Database
    readonly storage?: R2Bucket
    public readonly c: Context<T>
    secretResolver

    constructor(c: Context<T>, settings: z.infer<typeof databaseSettingsSchema>|DatabaseSettings|undefined, database: D1Database, storage?: R2Bucket) {
        this.c = c
        if((c.env as any).IS_VITEST){
            const h = c.req.header('$DB_TEST_DATABASE_SETTINGS')
            if(h) settings = JSON.parse(h) as DatabaseSettings
        }
        this.settings = databaseSettingsSchema.parse(settings ?? JSON.parse(c.env.DATABASE_SETTINGS||''))
        this.database = database
        this.storage = storage
        this.extensions.push(new MigrationHelper(this))
        this.secretResolver = new SecretResolver(c.env)

        // this can be set in the admin frontend to make sure we are working with the correct deployment of the worker
        const sv = c.req.header('DDB_SETTINGS_VERSION') // todo set in frontend
        if (sv && parseInt(sv) !== this.settings.version) {
            throw new HTTPException(500, {message: 'DDB_SETTINGS_VERSION_MISMATCH'}) // frontend needs to retry request. todo improve error
        }
        c.set('settings', this.settings) // todo is this required? we are setting $db also

        if (this.c.get('auth')) this.auth = this.c.get('auth')!
        else c.set('auth', this.auth);

        this.email = this.settings.email ? new EmailSendClient(this, {
            from: this.settings.email.from || undefined,
            variables: this.settings.email.variables,
            tags: this.settings.email.tags || [],
        }, this.settings.email.mailgun ? {
            ...this.settings.email.mailgun,
            MAILGUN_API_KEY: this.secretResolver.resolve(this.settings.email.mailgun.MAILGUN_API_KEY || ''),
        } : undefined) : null
        if(this.email) this.extensions.push(this.email)

        const jwtSecret = this.secretResolver.resolve(this.settings.jwtSecret)
        if (!jwtSecret?.length) throw new HTTPException(500, {message: 'Invalid configuration - jwt secret is required'})
        this.jwt = new JWTTokenHelper(jwtSecret, this.settings.jwtIssuer, this.settings.jwtAlgorithm)
        this.kv = new InternalKV(this.database, this.settings._kvTableName)
    }

    // setup db etc
    async setup() {
        const version = 0
        if(version >= 0) {
            //
        }
        await Promise.all([
            this.kv.setup(version),
            ...this.extensions.map(e => e.setup && e.setup(version)),
            ...this.settings.tables.map(t => this.table(t.name).setup(version))
        ])
    }

    async initAuth(tok?: string|false) {
        // console.log('c auth 2 ', this.c.get('auth'))
        if (this.c.get('auth')?.uid) {
            // this.auth = this.c.get('auth')
            // console.log('preset auth', this.auth)
            return
        }
        if(!tok) {
            const auth = this.c.req.header('Authorization')
            const isBearer = auth && auth.startsWith('Bearer ')
            tok = auth ? isBearer ? auth.slice(7) : auth : ''

            if (!tok) return
            // if(!isBearer) {
            //     // console.log('auth header not bearer', tok)
            //     return
            // }
        }


        let jwtSecret = this.secretResolver.resolve(this.c.env.ADMIN_JWT_SECRET ?? '')

        // todo hack, remove
        if (this.c.env.ADMIN_SERVICE_TOKEN && tok === this.c.env.ADMIN_SERVICE_TOKEN) {
            if (!jwtSecret) throw new HTTPException(500, {message: 'Invalid configuration - ADMIN_JWT_SECRET not set'})
            const tokenDuration = 3 * 60 * 60 // 3 hours
            const data = {
                sub: 'admin@example.com',
                id: '00000000000000000',
                meta: {},
                aud: "authenticated",
                verified: true,
                admin: true,
            } as any
            tok = await this.jwt.createJwtToken(data, jwtSecret, tokenDuration)
        }

        let payload = null as JWTPayloadOp | null
        try {
            payload = tok ? decode(tok).payload as JWTPayloadOp | null : null
        } catch (e) {
        }
        if (!payload) return

        if (payload.cid) {
            const table = this.settings.tables.find(t => t.name === payload!.cid)
            if (!table) throw new HTTPException(400, {message: 'Invalid auth table'})
            const auth = table.extensions.find(e => e.name === "auth") as TableAuthExtensionData
            jwtSecret = this.secretResolver.resolve(auth.jwtSecret)
        }

        if (!jwtSecret?.length) throw new HTTPException(401, {message: 'Invalid jwt'})

        payload = await this.jwt.decodeAuth(tok!, jwtSecret, false, undefined, payload).catch(e => {
            // console.error(e)
            return null
        })

        if (!payload) return
        const aud = Array.isArray(payload.aud) ? (payload.aud.length === 1 ? payload.aud[0] : payload.aud) : payload.aud
        this.auth = {
            uid: payload.id ?? null,
            cid: payload.cid, // table id
            email: payload.verified ? payload.sub : '',
            jwt: payload,
            role: aud ?? null,
            verified: Boolean(payload.verified) ?? false,
            meta: payload.meta ?? {},
            admin: Boolean(payload.admin) ?? false,
        } satisfies AuthContext

        // todo
        if (this.auth.cid && this.auth.admin) {
            throw new HTTPException(403, {message: 'Forbidden'})
        }
        this.c.set('auth', this.auth)
    }

    table(name: string) {
        if (this.tables[name]) return this.tables[name]
        const tableData = this.settings.tables.find(t => t.name === name)
        if (!tableData) throw new HTTPException(404, {message: `Table not found - ${name}`})
        const jc = createJsepContext(tableData.name, tableData, this.c, [tableData.name])
        const table = new $Table(tableData, jc, this).initialize()
        this.tables[name] = table
        return table
    }

    allTables(){
        const keys = this.settings.tables.map(t=>t.name)
        return keys.map(k=>this.table(k))
    }

    async run<T>(q: SQLQuery, err: string) {
        if (this.c.env.RESPOND_WITH_QUERY_LOG) {
            this.queryLog.push(logSQLQuery(q))
        }
        if (!q.q) return []
        const d1Expr = sqlQueryToD1Query(q)
        // return await runD1Query<T>(this.d1, d1Expr, err)

        const prepared = this.database.prepare(d1Expr.q).bind(...d1Expr.v)
        // console.log('Running query:', query.q, query.v)
        const onErr = (er: any)=>{
            // console.error(er, err, d1Expr)
            const msg = er.message ? er.message.replace(/D1_ERROR: /g, '') : 'Unknown error'
            // throw new HTTPException(500, { message: err + ' - ' + msg, asd });
            throw new D1Error(err || 'Unknown SQL Error', msg, er, logSQLQuery(q))
        }
        const res = await prepared.run<T>().catch(onErr)
        if(!res) onErr({message: 'No result'})
        if(!res.success) onErr(res.error)
        // console.log('Query result:', res)
        return res.results


    }

    async transaction(q: SQLQuery[], err: string) {
        if (this.c.env.RESPOND_WITH_QUERY_LOG) {
            this.queryLog.push(q.map(q1 => logSQLQuery(q1)).join(';\n'))
        }
        const d1Expr = q.map(sqlQueryToD1Query)
        // return await runD1Transaction(this.d1, d1Expr, err)

        const prepared = d1Expr.map(query=>query.q ? this.database.prepare(query.q).bind(...query.v) : null)
        // console.log('Running batch queries:', qs)
        const onErr = (er: any)=>{
            // console.error(er, err, d1Expr)
            const msg = er.message ? er.message.replace(/D1_ERROR: /g, '') : 'Unknown error'
            // throw new HTTPException(500, { message: err??'Error running transaction' });
            throw new D1Error(err || 'Unknown SQL Error(t)', msg, er, q.map(q1 => logSQLQuery(q1)).join(';\n'))
        }
        const p2 = prepared.filter(p=>!!p) as D1PreparedStatement[]
        const res = p2.length ? await this.database.batch(p2).catch(onErr) : []
        if(!res) onErr({message: 'No result'})

        let ki = 0
        const res2 = prepared.map((p, i)=>{
            if(!p) return {
                results: [],
                success: true,
                // meta: {},
            } /*as D1Result*/
            const r = res[ki++]
            // if(!r) return null
            // if(!r.success) onErr(r.error)
            return r
        })
        // console.log('Query result:', res)
        return res2
    }

    get bucket() {
        if (!this.storage) throw new HTTPException(500, {message: 'No bucket provided'});
        return this.storage
    }

    // Routing

    readonly _apiBase = '/api'
    readonly apiBase = this._apiBase + '/v1'
    readonly apiTableBase = this.apiBase + '/table'
    async route(path: string){
        if(!path.startsWith(this._apiBase+'/')) return undefined

        await this.initAuth() // load from bearer auth header

        if(path.startsWith(this.apiTableBase+'/')) {
            const p = path.replace(this.apiTableBase, '').split('/')
            const table = this.table(p[1]) // starts with /
            return table.route('/'+p.slice(2).join('/'))
        }
        if(path.startsWith(this.apiBase)) return await this._route(path.replace(this.apiBase, ''))
        return undefined
    }

    rawRouteHandler(route: HttpRoute): RawRouterHandlerFunction{
        return async(params)=>{
            if(typeof route.handler === 'function') {
                const data = await parseRequestBody(this.c.req)
                const res = await route.handler(data, params)
                if (res) return this.c.json(res)
                throw new ProcessError('Not found', 404)
            }else {
                return route.handler.raw(params)
            }
        }
    }

    private routes: HttpRoute[] = [{
        path: '/setup-db',
        method: 'post',
        handler: async()=>{
            if(!this.auth.admin) throw new HTTPException(403, {message: 'Forbidden'})
            await this.setup()
            return this.settings
        },
        zod: ()=>({
            description: 'Setup database (create tables etc)',
            request: {headers: z.object({authorization: z.string().min(1).max(255)}).describe('Admin Auth token')},
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
                const headers = new Headers();
                object.writeHttpMetadata(headers);
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
        const match = router.match(this.c.req.method, path)
        const [handler, params] = match[0]?.[0] ?? [undefined]
        if(!handler) return undefined
        return await handler(params as Record<string, string>)
    }
    getRoutes(){
        this._initRoutes()
        return this.routes
    }
}

export class SecretResolver{
    constructor(private env: any) {
    }
    resolve(secret?: string){
        return secret && secret[0] === '$' ? this.env[secret.slice(1)] || '' : secret
    }
}
