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
import {createJsepContext, honoToJsep, ident} from '../sql/parse/jsep'
import {logSQLQuery, QueryType, QueryTypes} from '../sql/build/query'
import {D1Query, sqlQueryToD1Query} from '../sql/build/d1'
import {z} from 'zod'
import {
    D1PreparedStatement,
    R2Conditional,
    R2GetOptions,
    R2Object,
    R2ObjectBody,
    R2PutOptions,
    ReadableStream
} from '@cloudflare/workers-types/2023-07-01/index'
import {MigrationHelper} from './migrationHelper'
import {LinearRouter} from 'hono/router/linear-router'
import {parseRequestBody} from './util/parseRequestBody'
import {HttpRoute, RawRouterHandlerFunction} from '../types/route'
import {$DBExtension} from './$DBExtension'
import {SQLProcedure, SQLQuery} from '../types/sql'
import {buildDeleteQuery, DeleteQuery} from '../sql/build/delete'
import {buildInsertQuery, InsertQuery} from '../sql/build/insert'
import {buildUpdateQuery, UpdateQuery} from '../sql/build/update'
import {buildSelectQuery, SelectQuery} from '../sql/build/select'
import {generateUid} from '../security/random'
import {getSQLiteSchema} from '../sql/schema/tableInfo'
import {
    D1PreparedQuery,
    D1PreparedTransaction,
    D1RunEvent,
    D1RunFailEvent,
    SQLRunContext,
    SQLRunTransactionContext
} from './util/sql'

export type $DatabaseEventMap = {
    run_sql: D1RunEvent
    run_sql_fail: D1RunFailEvent
}
export class $Database<T extends $Env = $Env> extends EventTarget<$DatabaseEventMap>{
    protected readonly tables: Record<string, $Table<T>> = {}
    readonly settings: DatabaseSettings
    auth: AuthContext = {
        jwt: {}, verified: false, admin: false,
        uid: null, role: null, email: null,
        meta: {}, cid: null, superadmin: false,
    }
    readonly queryLog: string[] = []

    readonly email: EmailSendClient<T> | null
    // readonly notify: NotifyClient
    readonly jwt: JWTTokenHelper
    readonly kv: InternalKV<T>
    readonly extensions: $DBExtension<T>[] = []

    public readonly c: Context<T>
    readonly secretResolver

    protected dryRunMode = false
    protected readOnlyMode = false

    private readonly adminJwtSecret: ()=>string

    constructor(c: Context<T>, settings: z.infer<typeof databaseSettingsSchema>|DatabaseSettings|undefined, database: D1Database, storage?: R2Bucket) {
        super()
        this.c = c
        if((c.env as any).IS_VITEST){
            const h = c.req.header('$DB_TEST_DATABASE_SETTINGS')
            if(h) settings = JSON.parse(h) as DatabaseSettings
        }
        this.settings = databaseSettingsSchema.parse(settings ?? JSON.parse(c.env.DATABASE_SETTINGS||''))
        this.database = database
        this.storage = storage
        this.extensions.push(new MigrationHelper(this))
        this.secretResolver = new SecretResolver(()=>c.env)

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

        // this.notify = new NotifyClient({}, this.email)

        const jwtSecret = ()=>this.secretResolver.resolve(this.settings.jwtSecret)
        if (!jwtSecret()?.length) throw new HTTPException(500, {message: 'Invalid configuration - jwt secret is required'})
        this.adminJwtSecret = ()=>this.c.env.ADMIN_JWT_SECRET ? this.secretResolver.resolve(this.c.env.ADMIN_JWT_SECRET) : ''
        this.jwt = new JWTTokenHelper(jwtSecret, this.settings.jwtIssuer, this.settings.jwtAlgorithm)
        this.kv = new InternalKV(this, this.settings._kvTableName)
    }

    // setup db etc
    async setup() {
        if(!this.auth.superadmin) throw new HTTPException(this.auth.uid ? 403 : 401, {message: 'Unauthorized'})
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
                const auth = this.c.req.header('Authorization')
                const isBearer = auth && auth.startsWith('Bearer ')
                tok = auth ? isBearer ? auth.slice(7) : auth : ''
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

        let jwtSecret = this.adminJwtSecret()

        // todo hack, remove
        if (this.c.env.ADMIN_SERVICE_TOKEN && tok === this.c.env.ADMIN_SERVICE_TOKEN) {
            tok = await this.generateAdminToken("superadmin", tok)
        }
        // console.log('init', tok)

        let payload = null as JWTPayloadOp | null
        try {
            payload = typeof tok === 'string' ? decode(tok).payload as JWTPayloadOp | null : null
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

        // console.log('init', payload, jwtSecret)
        payload = await this.jwt.decodeAuth(tok!, jwtSecret, false, undefined, payload).catch(e => {
            console.error(e)
            return null
        })
        // console.log('init', payload)

        if (!payload) return
        const aud = Array.isArray(payload.aud) ? (payload.aud.length === 1 ? payload.aud[0] : payload.aud) : payload.aud
        this.auth = {
            uid: payload.id ?? null,
            cid: payload.cid, // table id
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

    async generateAdminToken(role: string, tok?: string) {
        if(tok !== this.c.env.ADMIN_SERVICE_TOKEN && !this.auth.superadmin) throw new HTTPException(401, {message: 'Unauthorized'})
        const adminJwtSecret = this.adminJwtSecret()
        if (!adminJwtSecret) throw new HTTPException(500, {message: 'Invalid configuration - ADMIN_JWT_SECRET not set'})
        const tokenDuration = 3 * 60 * 60 // 3 hours
        const data = {
            sub: role + '@' + this.settings.appUrl.trim().replace(/^https?:\/\//, ''),
            id: generateUid(),
            meta: {},
            aud: role,
            verified: true,
            admin: true,
        } as any
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
                const res = await route.handler(data, params, path)
                if (res) return this.c.json(res)
                throw new ProcessError('Not found', 404)
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
        filesToDelete?: string[],
        then?: (r:T1[])=>TRet
    ){
        if(this.readOnlyMode) throw new ProcessError('DELETE not allowed in read only mode')

        if((query as DeleteQuery).table && (query as DeleteQuery).table !== table.jc.tableName) throw new ProcessError('Invalid table')

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
                if(filesToDelete && table.autoDeleteR2Files){
                    await this._deleteFiles(filesToDelete, table).catch(()=>{})
                }
            },
            then,
        })
    }

    rawInsert<T1 = any, TRet=T1[]>(
        table: $Table, query: OptionalOmit<InsertQuery, 'table'>,
        filesToUpload?: Record<string, File>, filesToRef?: string[],
        then?: (r:T1[])=>TRet
    ){
        if(this.readOnlyMode) throw new ProcessError('INSERT not allowed in read only mode')

        if((query as InsertQuery).table && (query as InsertQuery).table !== table.jc.tableName) throw new ProcessError('Invalid table')

        const sqlQs: [InsertQuery, SQLQuery][] = []
        if(Array.isArray(query.values)){
            // D1 has SQLITE_MAX_COMPOUND_SELECT of 5
            // https://github.com/cloudflare/workerd/blob/c3a0749df92ea56a362c2c132fe09fb69e0f92cd/src/workerd/util/sqlite.c%2B%2B#L1070
            // because - https://sqlite.org/security.html

            const batchSize = 5
            for (let i = 0; i < query.values.length; i += batchSize) {
                const batch = query.values.slice(i, i + batchSize)
                const insertQuery = {...query, values: batch, table: table.jc.tableName}
                const sql = buildInsertQuery(insertQuery, table.jc.autoSimplifyExpr)
                sqlQs.push([insertQuery, sql])
            }
        }else {
            const insertQuery = {...query, table: table.jc.tableName}
            const sql = buildInsertQuery(insertQuery, table.jc.autoSimplifyExpr)
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
            // TODO: its possible that some rows are not inserted because of where/rule in sql. those files need to be deleted. same in update and delete. we need to add a force returning clause with id? or can we use some other metadata
            if(filesToUpload) await this._deleteFiles(Object.keys(filesToUpload), table)
            return e
        }

        if(sqlQs.length === 1) {
           return this.prepare<T1, TRet, 'insert'>({
                table, type: 'insert',
                crudQuery: sqlQs[0][0],
                query: sqlQs[0][1],
                errorMessage: 'Failed to run insert query',
                onRun,
                onError,
                then,
            })
        }else {
            return this.transaction<T1, TRet, 'insert'>({
                table, type: 'insert',
                crudQuery: sqlQs.map(q=>q[0]),
                query: sqlQs.map(q=>q[1]),
                errorMessage: 'Failed to run insert query',
                onRun,
                onError,
                // @ts-ignore
                then: async (r)=> then ? then(r.flat()) : r.flat()
            })
        }

    }

    rawUpdate<T1 = any, TRet = T1[]>(
        table: $Table, query: OptionalOmit<UpdateQuery, 'table'>,
        filesToUpload?: Record<string, File>, filesToRef?: string[], filesToDelete?: string[],
        then?: (r:T1[])=>TRet
    ){
        if(this.readOnlyMode) throw new ProcessError('UPDATE not allowed in read only mode')

        if((query as UpdateQuery).table && (query as UpdateQuery).table !== table.jc.tableName) throw new ProcessError('Invalid table')

        const updateQuery = {...query, table: table.jc.tableName}
        const sql = buildUpdateQuery(updateQuery, table.jc.autoSimplifyExpr)

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
            if(filesToUpload) await this._deleteFiles(Object.keys(filesToUpload), table)
            return e
        }
        const onSuccess = async ()=>{
            // todo - make onUpdate
            // ignore error on fail
            if(filesToDelete && table.autoDeleteR2Files){
                await this._deleteFiles(filesToDelete, table).catch(()=>{})
            }
        }

        return this.prepare<T1, TRet, 'update'>({
            table, type: 'update',
            crudQuery: updateQuery,
            query: sql,
            errorMessage: 'Failed to run update query',
            onRun,
            onError,
            onSuccess,
            then,
        })
    }

    rawSelect<T=any, TRet=T[]>(table: $Table, query: OptionalOmit<SelectQuery, 'from'>, then?: (r:T[])=>TRet): D1PreparedQuery<T, T[], 'select'>|null
    rawSelect<T=any>(table: $Table, query: OptionalOmit<SelectQuery, 'from'>, countTotal: boolean): D1PreparedQuery<T, { items: T[], total: number }, 'select'>|null
    rawSelect<T=any, TRet=T[]>(table: $Table, query: OptionalOmit<SelectQuery, 'from'>, countTotal?: (boolean|((r:T[])=>TRet))){
        if((query as SelectQuery).from && (query as SelectQuery).from !== table.jc.tableName) throw new ProcessError('Invalid from table')
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
            table, type: 'select',
            crudQuery: [selectQuery, countSelectQuery],
            query: [sql, countQuery],
            errorMessage: 'Failed to run select query',
            then: async (r)=> ({items: r[0], total: (r[1][0] as any)?.total ?? -1})
        })
    }

    // endregion crud

    // region sql

    rawSQL<T>(d1Expr: D1Query, c?: SQLRunContext) {
        return this._prepareD1Query<T>(d1Expr, false, c)
    }
    rawSQLTransaction<T>(d1Expr: D1Query[], c?: SQLRunTransactionContext) {
        return this._prepareD1Transaction<T>(d1Expr, false, c)
    }
    // async sql<T>(d1Expr: D1Query, c?: SQLRunContext) {
    //     return await this.rawSQL<T>(d1Expr, c).run()
    // }
    // async sqlTransaction<T>(d1Expr: D1Query[], c?: SQLRunTransactionContext) {
    //     return await this.rawSQLTransaction<T>(d1Expr, c).run()
    // }

    // todo
    private async _rawProcedure(procedure: SQLProcedure){
        if(this.dryRunMode || this.c.env.RESPOND_WITH_QUERY_LOG)
            this.queryLog.push('PROCEDURE: ' + procedure.name)
        if(this.dryRunMode) return
        const statements = Array.isArray(procedure.statement) ? procedure.statement : procedure.statement ? [procedure.statement] : []
        const queries = Array.isArray(procedure.query) ? procedure.query ? procedure.query : [procedure.query] : []
        if(!statements.length && !queries.length) return // todo throw error?
        if(statements.length && queries.length) throw new ProcessError(`Invalid procedure ${procedure.name}, cannot have both statements and queries`)
        const rule = procedure.rule ?? true
        const prepared: (D1PreparedQuery<any, any, QueryType>|D1PreparedTransaction<any, any, QueryType>|null)[] = []
        if(queries.length){
            if(rule) throw new ProcessError(`Invalid procedure ${procedure.name}, cannot have raw queries with rule`)
            for (const query of queries) {
                if(!query) continue
                if(query.type === 'SELECT'){
                    if(Array.isArray(query.from)) throw new ProcessError(`Invalid procedure ${procedure.name}, cannot have multiple tables in select query`)
                    if(!query.from) throw new ProcessError(`Invalid procedure ${procedure.name}, missing from table in select query`)
                    prepared.push(this.rawSelect(this.table(query.from), query))
                }else if(query.type === 'UPDATE'){
                    prepared.push(this.rawUpdate(this.table(query.table), query))
                }else if(query.type === 'INSERT'){
                    prepared.push(this.rawInsert(this.table(query.table), query))
                }else if(query.type === 'DELETE'){
                    prepared.push(this.rawDelete(this.table(query.table), query))
                }
            }
        }
        if(statements.length){
            // todo handle when rule is false
            if(!rule) throw new ProcessError(`Invalid procedure ${procedure.name}, cannot have statements without rule, not supported yet`)
            for (const statement of statements) {
                if(!statement) continue
                const table = this.table(statement.table)
                if(statement.type === 'SELECT'){
                    prepared.push(await table.rawSelect(statement))
                }else if(statement.type === 'UPDATE'){
                    prepared.push(await table.rawUpdate(statement))
                }else if(statement.type === 'INSERT'){
                    prepared.push(await table.rawInsert(statement))
                }else if(statement.type === 'DELETE'){
                    prepared.push(await table.rawDelete(statement))
                }
            }
        }

        if(!prepared.length) return // todo throw error?

    }

    // endregion sql

    // region r2/s3

    async headFileObject(key: string){
        if(this.dryRunMode || this.c.env.RESPOND_WITH_QUERY_LOG)
            this.queryLog.push('STORAGE: headFileObject: ' + key)
        if(this.dryRunMode) throw new Error('headFile not supported in dry run mode')
        return this.bucket.head(key)
    }

    // todo need to keep types in sync with cloudflare, enforce it someway in ts so it errors when cloudflare changes something
    getFileObject(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
    async getFileObject(key: string, options?: R2GetOptions & {
        onlyIf: R2Conditional | Headers;
    }): Promise<R2ObjectBody | R2Object | null>{
        if(this.dryRunMode || this.c.env.RESPOND_WITH_QUERY_LOG)
            this.queryLog.push('STORAGE: getFileObject: ' + key)
        if(this.dryRunMode) throw new Error('getFile not supported in dry run mode')
        return this.bucket.get(key, options)
    }

    async putFileObject(
        key: string,
        value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
        options?: R2PutOptions & {
            onlyIf?: R2Conditional | Headers;
        },
    ): Promise<R2Object | null | {dummy: true}>{
        if(this.dryRunMode || this.c.env.RESPOND_WITH_QUERY_LOG)
            this.queryLog.push('STORAGE: putFileObject: ' + key) // todo add data about file?
        if(this.dryRunMode) return {dummy: true}
        if(this.readOnlyMode) throw new Error('putFile not allowed in read only mode')
        return this.bucket.put(key, value, options)
    }

    async deleteFileObject(keys: string | string[]){
        if(this.dryRunMode || this.c.env.RESPOND_WITH_QUERY_LOG)
            this.queryLog.push('STORAGE: deleteFileObject: ' + keys)
        if(this.dryRunMode) return
        if(this.readOnlyMode) throw new Error('deleteFile not allowed in read only mode')
        return this.bucket.delete(keys)
    }

    // endregion r2/s3

    // region private sql
    private readonly database: D1Database

    private prepare<T, TRet = T[], TC extends QueryType = QueryType>(c: SQLRunContext<T, TRet, TC>) {
        const q = c.query
        if (this.dryRunMode || this.c.env.RESPOND_WITH_QUERY_LOG) {
            this.queryLog.push(logSQLQuery(q))
        }
        const d1Expr = sqlQueryToD1Query(q)
        // return await runD1Query<T>(this.d1, d1Expr, err)
        if(this.dryRunMode) return null // todo add dummy data?
        return this._prepareD1Query(d1Expr, q._readOnly, c)
    }
    private transaction<T, TRet = T[][], TC extends QueryType = QueryType>(c: SQLRunTransactionContext<T, TRet, TC>) {
        const q = c.query
        if (this.dryRunMode || this.c.env.RESPOND_WITH_QUERY_LOG) {
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

    private _prepareD1Query<T, TRet = T[], TC extends QueryType = QueryType>(d1Expr: D1Query, readOnly = true, c?: SQLRunContext<T, TRet, TC>){
        if (this.readOnlyMode && !readOnly) throw new ProcessError('Running raw SQL is not allowed in read only mode.')
        if (this.dryRunMode) throw new ProcessError('Running raw SQL is not allowed in dry run.')
        const prep: D1PreparedQuery<T, TRet, TC> = {
            prepared: d1Expr.q ? this.database.prepare(d1Expr.q).bind(...d1Expr.v) : null,
            c,
            onError: async (er: any)=>{
                // todo only dispatch event if the error is from this query in transaction
                const msg = er.message ? er.message.replace(/D1_ERROR: /g, '') : 'Unknown error'
                // throw new HTTPException(500, { message: err??'Error running transaction' });
                const e = new D1Error(prep.c?.errorMessage || 'Unknown SQL Error', msg, er, prep.c?.query ? logSQLQuery(prep.c.query) : '')
                const error = prep.c?.table?.parseD1Error(e) ?? e
                this.dispatchEvent(new D1RunFailEvent({input: {...prep.c, d1Expr}, error: er}))
                return c?.onError ? c.onError(error) : error
            },
            onSuccess: async (res): Promise<T[]>=> {
                if (!res) throw new Error('Unknown error - No result')
                else if (!res.success) throw new Error(res.error)
                else {
                    // console.log('Query result:', res)
                    this.dispatchEvent(new D1RunEvent({input: {...prep.c, d1Expr}, result: res}))
                    c?.onSuccess && await c.onSuccess(res)
                    return res.results
                }
            },

            run: async ()=> this._exec(prep)
        }
        return prep
    }

    private _prepareD1Transaction<T, TRet = T[][], TC extends QueryType = QueryType>(d1Exprs: D1Query[], readOnly = false, c?: SQLRunTransactionContext<T, TRet, TC>): D1PreparedTransaction<T, TRet, TC> {
        const prepared = d1Exprs.map((query, i) => {
            return this._prepareD1Query<T, T[], TC>(query, readOnly, c ? {
                ...c,
                query: c.query[i],
                crudQuery: c.crudQuery[i],
                onError: undefined,
                onSuccess: undefined,
                onRun: undefined,
                then: undefined,
            } : undefined)
        })
        const prep = {
            prepared,
            c,
            run: async ()=> this._execBatch(prep)
        } as D1PreparedTransaction<T, TRet, TC>
        return prep
        // const onError = (er: any)=>{
        //     let i = 0
        //     for (const d1Expr of d1Exprs) {
        //         this.dispatchEvent(new D1RunFailEvent({input: {...c, d1Expr, query: c?.query[i], crudQuery: c?.crudQuery[i]}, error: er}))
        //         i++
        //     }
        //     return onErr ? onErr(er) : er
        // }
        // const onSuccess = (res: D1Result<T>[])=>{
        //     if (!res) throw onError({message: 'No result'})
        //     let ki = 0
        //     let i = 0
        //     const events: D1RunEvent[] = []
        //     const results = [] as (D1Result<T>|Omit<D1Result<T>, 'meta'>)[]
        //     for (const d1Expr of d1Exprs) {
        //         const p = prepared[i]
        //         const r = p ? res[ki] : ({success: true, results: []} as Omit<D1Result<T>, 'meta'>)
        //         if(p) events.push(new D1RunEvent({input: {...c, d1Expr, query: c?.query[i], crudQuery: c?.crudQuery[i]}, result: res[ki]}))
        //         if(!r.success) throw onError(r.error)
        //         results.push(r)
        //         i++
        //         if(p) ki++
        //     }
        //     events.forEach(e=>this.dispatchEvent(e))
        //
        //     return results
        // }
        //
        // // console.log('Running batch queries:', qs)
        //
        // // todo proper error return for transaction
        // const p2 = prepared.filter(p => !!p) as D1PreparedStatement[]
        // return [p2, onSuccess, onError]
        // return async ()=>{
        //     const res = p2.length ? await this.database.batch<T>(p2).catch((e)=>{
        //         throw onError(e)
        //     }) : []
        //     return onSuccess(res)
        // }
    }


    private async _exec<T, TRet = T[]>(prep: D1PreparedQuery<T, TRet>): Promise<TRet|null> {
        let res
        try{
            prep.c?.onRun && await prep.c.onRun()
            res = await prep.prepared?.run<T>()
        }catch (e){
            throw await prep.onError(e)
        }
        let ret
        try{
            ret = await prep.onSuccess(res ?? {success: true, results: []})
        }catch (e){
            console.error('Unknown error in onSuccess', res, e)
            ret = res?.results||[]
        }
        try {
            // @ts-expect-error TS2322 unavoidable
            return prep.c?.then ? await prep.c.then(ret) : ret
        }catch (e){
            console.error('Unknown error in then, ignored', ret, e)
            return null
        }
    }

    private async _execBatch<T = any, TRet = T[][]>(transaction: D1PreparedTransaction<T, TRet>): Promise<TRet|null>{
        const statements: D1PreparedStatement[] = []
        const onRuns: (()=>Promise<void>)[] = []
        const onErrors: ((e: any)=>any)[] = []
        function collect(t: D1PreparedTransaction<T, TRet>){
            t.c?.onRun && onRuns.push(t.c.onRun)
            t.c?.onError && onErrors.push(t.c.onError)
            for (const prep of t.prepared) {
                if(Array.isArray(prep.prepared)){
                    collect(prep as D1PreparedTransaction<T, TRet>)
                }else if (prep.prepared) {
                    const prep1 = prep as D1PreparedQuery<T, TRet>;
                    prep.c?.onRun && onRuns.push(prep.c.onRun)
                    prep1.onError && onErrors.push(prep1.onError)
                    statements.push(prep.prepared)
                }
            }
        }
        collect(transaction)

        let res: D1Result<T>[]
        try {
            for (const onRun of onRuns) { // todo promise.all in batch?
                await onRun()
            }
            res = await this.database.batch<T>(statements)
        }catch (e) {
            for (const onError of onErrors) {
                try {
                    e = await onError(e)
                }catch (e1){
                    console.error('Unknown error in onError', e1)
                    e = e1
                }
            }
            throw e
        }
        let i = 0
        async function collectResults(t: D1PreparedTransaction<T, TRet>){
            let res2: T[][] = []
            for (const prep1 of t.prepared) {
                if(Array.isArray(prep1.prepared)){
                    const prep = prep1 as D1PreparedTransaction<T, TRet>
                    const res3 = await collectResults(prep)
                    if (Array.isArray(res3)) {
                        res2.push(...res3)
                    } else {
                        console.error('Invalid result in nested transaction, expected array, ignored', res3)
                        // res2.push()
                    }
                }else {
                    const prep = prep1 as D1PreparedQuery<T, T[], 'select'>;
                    const r = prep.prepared ? res[i++] : ({success: true, results: []} as Omit<D1Result<T>, 'meta'>)
                    let ret: T[]
                    try{
                        ret = await prep.onSuccess(r)
                    }catch (e){
                        console.error('Unknown error in onSuccess, ignored', r, e)
                        ret = r?.results||[]
                    }
                    try {
                        res2.push(prep.c?.then ? await prep.c.then(ret) : ret)
                    }catch (e){
                        console.error('Unknown error in then, ignored', ret, e)
                        // res2.push(null)
                    }
                }
            }
            try{
                t.c?.onSuccess && await t.c.onSuccess(res2)
            }catch (e){
                console.error('Unknown error in onSuccess, ignored', res, e)
            }
            try{
                return (t.c?.then ? await t.c.then(res2) : res2) as TRet
            }catch (e){
                console.error('Unknown error in then, ignored', res2, e)
                return null
            }
        }

        return await collectResults(transaction)
    }

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
            const res = await this.putFileObject(table.fileKey(key), file, {
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
        if(hasError) {
            const errors = res.filter(r=>r.status === 'rejected').map((r: any)=>r.reason)
            console.error(errors)
            console.log('Deleting uploaded files', successful)
            await this.deleteFileObject(successful.map(r=>r.key)).catch(e=>{
                console.error('Unable to delete some files after upload error', e)
                // todo mark for delete somehow in logs
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

    // endregion private r2/s3

    // region routing

    private routes: HttpRoute[] = [{
        path: '/setup-db',
        method: 'post',
        handler: async()=>{
            await this.setup()
            return this.settings
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
            if(isRaw !== undefined && (isRaw===''||z.coerce.boolean().parse(isRaw)))
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
    }, {
        method: 'get',
        path: '/explain/*',
        handler: {
            raw: async (_params, path) => {
                if (!this.auth.admin || !this.c.env.RESPOND_WITH_QUERY_LOG) throw new HTTPException(this.auth.uid ? 403 : 401, {message: 'Forbidden'})
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
                        result: z.object({status: z.number(), body: z.string(), headers: z.record(z.string())}).optional(),
                    })}},
                },
            },
        })

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

export class SecretResolver{
    constructor(private readonly env: ()=>any) {
    }
    resolve(secret?: string){
        const env = this.env()
        return secret && secret[0] === '$' ? env[secret.slice(1)] || '' : secret
    }
}

export type OptionalOmit<T, K extends keyof T> = Omit<T, K> & Pick<Partial<T>, K>;


// export type NotifyModes = 'email'|'discord'/*|'slack'|'webhook'*/
// export class NotifyClient{
//     constructor(private props: {}, private email: EmailSendClient<any>|null) {
//     }
//
//     send(mode: NotifyModes){
//
//     }
// }
