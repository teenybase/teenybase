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
import {logSQLQuery} from '../sql/build/query'
import {D1Query, sqlQueryToD1Query} from '../sql/build/d1'
import {z} from 'zod'
import type {
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
import {SQLQuery} from '../types/sql'
import {buildDeleteQuery, DeleteQuery} from '../sql/build/delete'
import {buildInsertQuery, InsertQuery} from '../sql/build/insert'
import {buildUpdateQuery, UpdateQuery} from '../sql/build/update'
import {buildSelectQuery, SelectQuery} from '../sql/build/select'
import {generateUid} from '../security/random'
import {getSQLiteSchema} from '../sql/schema/tableInfo'

export class $Database<T extends $Env = $Env>{
    protected readonly tables: Record<string, $Table<T>> = {}
    readonly settings: DatabaseSettings
    auth: AuthContext = {
        jwt: {}, verified: false, admin: false,
        uid: null, role: null, email: null,
        meta: {}, cid: null, superadmin: false,
    }
    readonly queryLog: string[] = []

    readonly email: EmailSendClient<T> | null
    jwt: JWTTokenHelper
    kv: InternalKV<T>
    extensions: $DBExtension<T>[] = []

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
        this.adminJwtSecret = this.c.env.ADMIN_JWT_SECRET ? this.secretResolver.resolve(this.c.env.ADMIN_JWT_SECRET) : ''
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

        let jwtSecret = this.adminJwtSecret

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
        if (!this.adminJwtSecret) throw new HTTPException(500, {message: 'Invalid configuration - ADMIN_JWT_SECRET not set'})
        const tokenDuration = 3 * 60 * 60 // 3 hours
        const data = {
            sub: role + '@' + this.settings.appUrl.trim().replace(/^https?:\/\//, ''),
            id: generateUid(),
            meta: {},
            aud: role,
            verified: true,
            admin: true,
        } as any
        return await this.jwt.createJwtToken(data, this.adminJwtSecret, tokenDuration)
    }

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

    readonly _apiBase = '/api'
    readonly apiBase = this._apiBase + '/v1'
    readonly apiTableSuffix = '/table'
    readonly apiTableBase = this.apiBase + this.apiTableSuffix
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

    // crud

    async rawDelete<T1 = any>(table: $Table, query: OptionalOmit<DeleteQuery, 'table'>, filesToDelete?: string[]){
        if(this.readOnlyMode) throw new ProcessError('DELETE not allowed in read only mode')

        if((query as DeleteQuery).table && (query as DeleteQuery).table !== table.jc.tableName) throw new ProcessError('Invalid table')

        const sql = buildDeleteQuery({...query, table: table.jc.tableName}, table.jc.autoSimplifyExpr)

        // todo make beforeDelete
        const res = await this.run<T1>(sql, 'Failed to run delete query', table)

        // todo make onDelete
        // ignore error on fail
        if(filesToDelete && table.autoDeleteR2Files){
            await this._deleteFiles(filesToDelete, table).catch(()=>{})
        }
        return res
    }

    async rawInsert<T1 = any>(table: $Table, query: OptionalOmit<InsertQuery, 'table'>, filesToUpload?: Record<string, File>, filesToRef?: string[]){
        if(this.readOnlyMode) throw new ProcessError('INSERT not allowed in read only mode')

        if((query as InsertQuery).table && (query as InsertQuery).table !== table.jc.tableName) throw new ProcessError('Invalid table')

        const sqlQs: SQLQuery[] = []
        if(Array.isArray(query.values)){
            // D1 has SQLITE_MAX_COMPOUND_SELECT of 5
            // https://github.com/cloudflare/workerd/blob/c3a0749df92ea56a362c2c132fe09fb69e0f92cd/src/workerd/util/sqlite.c%2B%2B#L1070
            // because - https://sqlite.org/security.html

            const batchSize = 5
            for (let i = 0; i < query.values.length; i += batchSize) {
                const batch = query.values.slice(i, i + batchSize)
                const sql = buildInsertQuery({...query, values: batch, table: table.jc.tableName}, table.jc.autoSimplifyExpr)
                sqlQs.push(sql)
            }
        }else {
            const sql = buildInsertQuery({...query, table: table.jc.tableName}, table.jc.autoSimplifyExpr)
            sqlQs.push(sql)
        }
        // const sql = buildInsertQuery({...query, table: table.jc.tableName}, table.jc.autoSimplifyExpr)

        // todo - make beforeInsert
        // will throw error on fail
        filesToRef && await this._refCheckFiles(filesToRef, table)
        filesToUpload && await this._uploadFiles(filesToUpload, table)

        let res: T1[] | null = null
        let err = null as any
        try {
            if(sqlQs.length === 1) {
                res = await this.run<T1>(sqlQs[0], 'Failed to run insert query', table)
            }else {
                res = (await this.transaction<T1>(sqlQs, 'Failed to run insert query')).flatMap(r => r.results)
            }
        }catch (e){
            console.error(e)
            err = e
            res = null
        }

        // todo - make onInsertFail
        // if error, delete uploaded files
        if(res === null){
            // TODO: its possible that some rows are not inserted because of where/rule in sql. those files need to be deleted. same in update and delete. we need to add a force returning clause with id? or can we use some other metadata
            if(filesToUpload) await this._deleteFiles(Object.keys(filesToUpload), table)
            throw (err ?? new HTTPException(500, { message: 'Failed to insert' }))
        }

        return res
    }

    async rawUpdate<T1 = any>(table: $Table, query: OptionalOmit<UpdateQuery, 'table'>, filesToUpload?: Record<string, File>, filesToRef?: string[], filesToDelete?: string[]){
        if(this.readOnlyMode) throw new ProcessError('UPDATE not allowed in read only mode')

        if((query as UpdateQuery).table && (query as UpdateQuery).table !== table.jc.tableName) throw new ProcessError('Invalid table')

        const sql = buildUpdateQuery({...query, table: table.jc.tableName}, table.jc.autoSimplifyExpr)

        // todo - make beforeUpdate

        // will throw error on fail
        filesToRef && await this._refCheckFiles(filesToRef, table)
        filesToUpload && await this._uploadFiles(filesToUpload, table)

        let res: T1[]|null
        let err = null as any
        try {
            res = await this.run<T1>(sql, 'Failed to run update query', table)
        }catch (e){
            console.error(e)
            err = e
            res = null
        }

        // todo - make onUpdateFail
        // if error, delete uploaded files
        if(res === null){
            if(filesToUpload) await this._deleteFiles(Object.keys(filesToUpload), table)
            throw (err ?? new HTTPException(500, { message: 'Failed to update' }))
        }

        // todo - make onUpdate
        // ignore error on fail
        if(filesToDelete && table.autoDeleteR2Files){
            await this._deleteFiles(filesToDelete, table).catch(()=>{})
        }

        return res
    }

    async rawSelect<T=any>(table: $Table, query: OptionalOmit<SelectQuery, 'from'>): Promise<T[]>
    async rawSelect<T=any>(table: $Table, query: OptionalOmit<SelectQuery, 'from'>, countTotal: boolean): Promise<{ items: T[], total: number }>
    async rawSelect<T=any>(table: $Table, query: OptionalOmit<SelectQuery, 'from'>, countTotal?: boolean){
        if((query as SelectQuery).from && (query as SelectQuery).from !== table.jc.tableName) throw new ProcessError('Invalid from table')
        const sql = buildSelectQuery({...query, from: table.jc.tableName}, table.jc.autoSimplifyExpr)
        // console.log(query, sql)

        if(!countTotal) {
            const res = await this.run(sql, 'Failed to run select query', table)
            // console.log(res)
            return countTotal === undefined ? res : {items: res, total: -1}
        }

        const countField = table.mapping.uid ? ident(table.mapping.uid, table.jc) : '*'
        // const countField = table.mapping.uid ? `DISTINCT ${table.data.name}.${columnify(table.mapping.uid)}` : '*'

        const countQuery = buildSelectQuery({
            ...query,
            from: table.jc.tableName,
            selects: [`count(${countField}) as total`],
            limit: undefined,
            offset: undefined,
            orderBy: undefined,
            groupBy: undefined,
            distinct: false,
        }, table.jc.autoSimplifyExpr)

        const res = await this.transaction([sql, countQuery], 'Failed to run select query', table)

        return {items: res[0].results, total: (res[1].results[0] as any)?.total ?? -1}
    }

    async rawSQL<T>(d1Expr: D1Query, onErr?: (er: any) => any) {
        return this._rawSQL<T>(d1Expr, onErr, false)
    }

    async rawSQLTransaction<T>(d1Expr: D1Query[], onErr?: (er: any) => any) {
        return this._rawSQLTransaction<T>(d1Expr, onErr, false)
    }

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

    dryRunMode = false
    readOnlyMode = false

    private readonly database: D1Database
    private readonly storage?: R2Bucket
    private adminJwtSecret: string

    private async run<T>(q: SQLQuery, err: string, table?: $Table) {
        if (this.dryRunMode || this.c.env.RESPOND_WITH_QUERY_LOG) {
            this.queryLog.push(logSQLQuery(q))
        }
        if (!q.q) return []
        const d1Expr = sqlQueryToD1Query(q)
        // return await runD1Query<T>(this.d1, d1Expr, err)
        const onErr = (er: any)=>{
            // console.error(er, err, d1Expr)
            const msg = er.message ? er.message.replace(/D1_ERROR: /g, '') : 'Unknown error'
            // throw new HTTPException(500, { message: err + ' - ' + msg, asd });
            const e = new D1Error(err || 'Unknown SQL Error', msg, er, logSQLQuery(q))
            return table?.parseD1Error(e) ?? e
        }
        if(this.dryRunMode) return [] // todo add dummy data?
        return await this._rawSQL<T>(d1Expr, onErr, q._readOnly)
    }
    private async transaction<T>(q: SQLQuery[], err: string, table?: $Table) {
        if (this.dryRunMode || this.c.env.RESPOND_WITH_QUERY_LOG) {
            this.queryLog.push(q.map(q1 => logSQLQuery(q1)).join(';\n'))
        }
        const d1Expr = q.map(sqlQueryToD1Query)
        // return await runD1Transaction(this.d1, d1Expr, err)
        const onErr = (er: any)=>{
            // console.error(er, err, d1Expr)
            const msg = er.message ? er.message.replace(/D1_ERROR: /g, '') : 'Unknown error'
            // throw new HTTPException(500, { message: err??'Error running transaction' });
            const e = new D1Error(err || 'Unknown SQL Error(t)', msg, er, q.map(q1 => logSQLQuery(q1)).join(';\n'))
            return table?.parseD1Error(e) ?? e
        }
        if(this.dryRunMode) return [] // todo add dummy data?
        return await this._rawSQLTransaction<T>(d1Expr, onErr, q.every(q1=>q1._readOnly))
    }

    private async _rawSQL<T>(d1Expr: D1Query, onErr?: (er: any) => any, readOnly = false) {
        if (this.readOnlyMode && !readOnly) throw new ProcessError('Running raw SQL is not allowed in read only mode.')
        if (this.dryRunMode) throw new ProcessError('Running raw SQL is not allowed in dry run.')
        if(!onErr) onErr = (er: any)=>er

        const prepared = this.database.prepare(d1Expr.q).bind(...d1Expr.v)
        // console.log('Running query:', query.q, query.v)
        const res = await prepared.run<T>().catch((e)=>{
            throw onErr(e)
        })
        if (!res) throw onErr({message: 'No result'})
        else if (!res.success) throw onErr(res.error)
        // console.log('Query result:', res)
        else return res.results
    }
    private async _rawSQLTransaction<T>(d1Expr: D1Query[], onErr?: (er: any) => any, readOnly = false) {
        if (this.readOnlyMode && !readOnly) throw new ProcessError('Running raw SQL is not allowed in read only mode.')
        if (this.dryRunMode) throw new ProcessError('Running raw SQL is not allowed in dry run.')
        if(!onErr) onErr = (er: any)=>er

        const prepared = d1Expr.map(query => query.q ? this.database.prepare(query.q).bind(...query.v) : null)
        // console.log('Running batch queries:', qs)

        // todo proper error return for transaction

        const p2 = prepared.filter(p => !!p) as D1PreparedStatement[]
        const res = p2.length ? await this.database.batch<T>(p2).catch((e)=>{
            throw onErr(e)
        }) : []
        if (!res) throw onErr({message: 'No result'})

        let ki = 0
        const res2 = prepared.map((p, i) => {
            if (!p) return {
                results: [],
                success: true,
                // meta: {},
            } as Omit<D1Result<T>, 'meta'>
            const r = res[ki++]
            // if(!r) return null
            // if(!r.success) onErr(r.error)
            return r
        })
        // console.log('Query result:', res)
        return res2
    }

    private get bucket() {
        if (!this.storage) throw new HTTPException(500, {message: 'No bucket provided'});
        return this.storage
    }

    // table specific file handling

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

    // Routing

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
            raw: async () => {
                if (!this.auth.admin || !this.c.env.RESPOND_WITH_QUERY_LOG) throw new HTTPException(this.auth.uid ? 403 : 401, {message: 'Forbidden'})
                this.dryRunMode = true
                const path = this.c.req.path.replace(this.apiBase, '').replace('/explain', '')
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

export type OptionalOmit<T, K extends keyof T> = Omit<T, K> & Pick<Partial<T>, K>;
