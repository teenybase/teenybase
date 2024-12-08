import {TableExtension} from './tableExtension'
import {buildInsertQuery, InsertQuery} from '../sql/build/insert'
import {extensions, ExtensionsKeys, TableExtensions} from './extensions'
import {
    appendJoin, appendOrderBy,
    buildSelectQuery,
    getSubSelectQueries,
    SelectQuery,
    SelectQueryJoin,
    SelectQuerySelect
} from '../sql/build/select'
import {buildDeleteQuery, DeleteQuery} from '../sql/build/delete'
import {buildUpdateQuery, UpdateQuery} from '../sql/build/update'
import {HTTPException} from 'hono/http-exception'
import {parseUpdateQuery, UpdateParams, updateSchema} from '../sql/parse/update'
import {InsertParams, insertSchema, parseInsertQuery} from '../sql/parse/insert'
import {parseSelectQuery, SelectParams, selectSchema} from '../sql/parse/select'
import {DeleteParams, deleteSchema, parseDeleteQuery} from '../sql/parse/delete'
import {z} from 'zod'
import {TableFieldUsage} from './usages'
import {generateUid, randomString} from '../security/random'
import {$Database} from './$Database'
import {D1Error, ProcessError} from './util/error'
import {TableCrudExtension} from './extensions/tableCrudExtention'
import {TableFieldData} from '../types/field'
import {TableData} from '../types/table'
import {columnify, ident, JsepContext, uncolumnify} from '../sql/parse/jsep'
import {SQLQuery, sqlValSchemaFile2, sqlValSchemaFile3, sqlValSchemaRecord} from '../types/sql'
import {$Env} from './env'
import {tableFieldTypeToZod} from '../types/dataTypes'
import {LinearRouter} from 'hono/router/linear-router'
import {HttpRoute, RawRouterHandlerFunction} from '../types/route'
import {normalizeFileName} from './util/string'
import {fts5TableName} from '../sql/schema/tableQueries'

export class $Table<T extends $Env = any>{
    extensions: TableExtension[] = []

    readonly fileFields?: string[]
    // jsonFields?: string[]
    // editorFields?: string[]

    readonly mapping
    readonly fields: Record<string, TableFieldData>
    /**
     * Maps usage strings to field name/array of field names(for multiple)
     */
    readonly fieldsUsage: Record<TableFieldUsage, string|string[]|undefined>

    readonly autoDeleteR2Files: boolean
    readonly allowMultipleFileRef: boolean

    private _zodSchema: z.ZodObject<any> | undefined
    get zodSchema(){
        if(this._zodSchema) return this._zodSchema
        const schema = {} as Record<string, z.ZodType<any>>
        for (const field of this.data.fields) {
            schema[field.name] = tableFieldTypeToZod[field.type as keyof typeof tableFieldTypeToZod]
                ?? tableFieldTypeToZod[field.sqlType as keyof typeof tableFieldTypeToZod]
        }
        this._zodSchema = z.object(schema)
        return this._zodSchema
    }

    extension<T extends ExtensionsKeys>(key: T): TableExtensions[T]{
        const ext = this.extensions.find(e=>e.name === key)
        if(!ext) throw new ProcessError('Extension not found', 500)
        return ext as any
    }

    get name(){
        return this.data.name
    }
    // get id(){
    //     return this.data.id
    // }

    constructor(public data: TableData, public jc: JsepContext, public readonly $db: $Database<T>) {
        this.fieldsUsage = data.fields.reduce((acc: any, f)=>{
            if(!f.usage) return acc
            let v = acc[f.usage]
            if(!v) v = f.name
            else if(Array.isArray(v)) v.push(f.name)
            else v = [v, f.name]
            acc[f.usage] = v
            return acc
        }, {} as Record<TableFieldUsage, string|string[]>)
        this.mapping = {
            uid: z.string().optional().parse(this.fieldsUsage.record_uid), // uid. this is for unique id(used in view route, auth etc).
            created: z.string().optional().parse(this.fieldsUsage.record_created), // created
            updated: z.string().optional().parse(this.fieldsUsage.record_updated), // updated
        } as const

        this.fields = Object.fromEntries(this.data.fields.map(f => [f.name, f]))

        this.fileFields = this.data.fields.filter(f=>f.type==='file').map(f=>f.name)

        this.extensions.push(new TableCrudExtension({name: 'crud'}, this, jc))
        for (const ext of data.extensions) {
            const extClass = (extensions as any)[ext.name]
            // todo dont pass $db.c here, remove dep from TableAuthExtension
            if (extClass) this.extensions.push(new extClass(ext as any, this, jc, $db.c))
            else throw new ProcessError('Invalid extension ' + ext.name + ' for table ' + data.name, 500)
        }

        if(this.data.idInR2 && (!this.mapping.uid || !this.fields[this.mapping.uid].noUpdate)) throw new ProcessError('Invalid Configuration for idInR2 - uid field must be present and set to noUpdate', 500)

        this.autoDeleteR2Files = this.data.autoDeleteR2Files !== undefined ? this.data.autoDeleteR2Files : true
        this.allowMultipleFileRef = this.data.allowMultipleFileRef !== undefined ? this.data.allowMultipleFileRef : false

        if(this.allowMultipleFileRef && this.data.idInR2) throw new ProcessError('Invalid Configuration for idInR2 - allowMultipleFileRef cannot be true', 500)
        if(this.allowMultipleFileRef && this.autoDeleteR2Files) throw new ProcessError('Invalid Configuration for autoDeleteR2Files - allowMultipleFileRef cannot be true', 500)
    }

    // setup db etc
    async setup(version: number){
        // for (const ext of this.extensions) {
        //     ext.setup && ext.setup()
        // }
        return this
    }

    // todo why is initialize required?
    // if it needs to be initialized then wait for it in any function call.
    initialize() {
        for (const ext of this.extensions) {
            ext.initialize && ext.initialize()
        }
        return this
    }

    // crud

    async delete(data: TableDeleteParams) {
        const query = await parseDeleteQuery(data, this.jc).catch(e=>{
            throw new ProcessError('Error parsing DELETE data', 400, {input: data}, e)
        })
        await this.onDeleteParse(query)

        // todo make beforeDelete
        const filesToDelete = await this.filesToDelete(query)

        const sql = buildDeleteQuery(query, this.jc.autoSimplifyExpr)
        const res = await this.run(sql, 'Failed to run delete query')

        // todo make onDelete
        // ignore error on fail
        if(filesToDelete && this.autoDeleteR2Files){
            await this._deleteFiles(filesToDelete).catch(()=>{})
        }

        return res
    }

    async insert(data: TableInsertParams) {
        // console.error('insert', data)
        const values = Array.isArray(data.values) ? data.values : [data.values]
        let filesToUpload = {} as Record<string, File>
        let filesToRef: string[] = []
        const data2 = {
            ...data,
            values: [] as z.infer<typeof sqlValSchemaRecord>[]
        } as const
        if(values) {
            for (const setValues of values) {
                for (const [key, val] of Object.entries(setValues)) { // todo
                    if(Array.isArray(val)) throw new ProcessError('Array values not supported at the moment')
                }
                const {values: _values} = this.filesToUpload(setValues, filesToUpload, filesToRef)
                data2.values.push(_values)
            }
        }

        // todo - make beforeInsertParse

        const query = await parseInsertQuery(data2, this.jc).catch(e=>{
            throw new ProcessError('Error parsing INSERT data', 400, {input:data}, e)
        })

        await this.onInsertParse(query)

        const sql = buildInsertQuery(query, this.jc.autoSimplifyExpr)

        // todo - make beforeInsert
        // will throw error on fail
        filesToRef && await this._refCheckFiles(filesToRef)
        filesToUpload && await this._uploadFiles(filesToUpload)

        let res: any[] | null = null
        let err = null as any
        try {
            res = await this.run(sql, 'Failed to run insert query')
        }catch (e){
            console.error(e)
            err = e
            res = null
        }

        // todo - make onInsertFail
        // if error, delete uploaded files
        if(res === null){
            // TODO: its possible that some rows are not inserted because of where/rule in sql. those files need to be deleted. same in update and delete
            if(filesToUpload) await this._deleteFiles(Object.keys(filesToUpload))
            throw (err ?? new HTTPException(500, { message: 'Failed to insert' }))
        }

        return res
    }

    async update(data: TableUpdateParams) {
        if(data.setValues) for (const [key, val] of Object.entries(data.setValues)) { // todo
            if(Array.isArray(val)) throw new ProcessError('Array values not supported at the moment')
        }
        const set = data.set
        if(set && this.fileFields) for (const [key, val] of Object.entries(set)) {
            if(this.fileFields.includes(key)) throw new ProcessError('File fields can only be set using setValues')
        }

        // todo - make beforeUpdateParse
        const {filesToUpload, filesToRef, values} = data.setValues ? this.filesToUpload(data.setValues) : {}
        const data2 = {
            ...data,
            setValues: values,
        } as const

        const updateQuery = await parseUpdateQuery(data2, this.jc).catch(e=>{
            throw new ProcessError('Error parsing UPDATE data', 400, {input:data}, e)
        })

        await this.onUpdateParse(updateQuery)

        // todo - make beforeUpdate
        const fileFields = this.fileFields?.filter(f => updateQuery.set[f])
        const filesToDelete = fileFields ? await this.filesToDelete(updateQuery, fileFields) : undefined

        const sql = buildUpdateQuery(updateQuery)

        // will throw error on fail
        filesToRef && await this._refCheckFiles(filesToRef)
        filesToUpload && await this._uploadFiles(filesToUpload)

        let res: any
        let err = null as any
        try {
            res = await this.run(sql, 'Failed to run update query')
        }catch (e){
            console.error(e)
            err = e
            res = null
        }

        // todo - make onUpdateFail
        // if error, delete uploaded files
        if(res === null){
            if(filesToUpload) await this._deleteFiles(Object.keys(filesToUpload))
            throw (err ?? new HTTPException(500, { message: 'Failed to update' }))
        }

        // todo - make onUpdate
        // ignore error on fail
        if(filesToDelete && this.autoDeleteR2Files){
            await this._deleteFiles(filesToDelete).catch(()=>{})
        }

        return res
    }

    async view(data: TableViewParams, id: string) {
        if(!this.mapping.uid) throw new HTTPException(404, {message: 'Not supported without uidField.'})
        const query = await parseSelectQuery({
            where: `${this.data.name}.${this.mapping.uid}='${id}'`,
            limit: 1,
            select: data.select,
        }, this.jc).catch(e=>{
            throw new ProcessError('Error parsing SELECT(view) data', 400, {input:data}, e)
        })

        await this.onViewParse(query, id)

        const sql = buildSelectQuery(query, this.jc.autoSimplifyExpr)
        const res = await this.run<any>(sql, 'Failed to run select query')
        return res[0]
    }

    async select(data: TableSelectParams): Promise<any[]>
    async select(data: TableSelectParams, countTotal: boolean): Promise<{ items: any[], total: number }>
    async select(data: TableSelectParams, countTotal?: boolean) {
        const query = await parseSelectQuery(data, this.jc).catch(e=>{
            throw new ProcessError('Error parsing SELECT data', 400, {input:data}, e)
            // throw new ProcessErrore: 'Invalid query')
        })
        await this.onSelectParse(query)

        const sql = buildSelectQuery(query, this.jc.autoSimplifyExpr)
        // console.log(query, sql)

        if(!countTotal) {
            const res = await this.run(sql, 'Failed to run select query')
            // console.log(res)
            return countTotal === undefined ? res : {items: res, total: -1}
        }

        const countField = this.mapping.uid ? `${this.data.name}.${columnify(this.mapping.uid)}` : '*'
        // const countField = this.mapping.uid ? `DISTINCT ${this.data.name}.${columnify(this.mapping.uid)}` : '*'

        const countQuery = buildSelectQuery({
            ...query,
            selects: [`count(${countField}) as total`],
            limit: undefined,
            offset: undefined,
            orderBy: undefined,
            groupBy: undefined,
            distinct: false,
        }, this.jc.autoSimplifyExpr)

        const res = await this.transaction([sql, countQuery], 'Failed to run select query')

        return {items: res[0].results, total: (res[1].results[0] as any)?.total ?? -1}
    }

    // hooks

    protected async onInsertParse(query: InsertQuery) {
        let v = Array.isArray(query.values) ? query.values : [query.values]
        if(v.length && v[0]) {
            const setKeys = Object.keys(v[0]) // its checked in the buildInsert if all the rows share the same key. todo should it be done here?
            for (const key of setKeys) {
                const field = this.fields[key]
                // if (!field) throw new ProcessError: 'Invalid field ' + key}) // this check is moved below.
                if (!field) continue
                // if (field.usage && noInsertSetUsages.includes(field.usage)) throw new ProcessError('Cannot insert ' + key + ' field')
                if (field.noInsert) throw new ProcessError('Cannot insert ' + key + ' field')
            }
            if (this.mapping.uid && this.data.autoSetUid) {
                for (const val of v) {
                    if (!val[this.mapping.uid]) val[this.mapping.uid] = {l: generateUid()}
                }
            }
        }

        if(query.returning) query.returning = this.checkColsWildcard(Array.isArray(query.returning) ? query.returning : [query.returning], this.data.allowWildcard ?? false)

        for (const ext of this.extensions) {
            ext.onInsertParse && await ext.onInsertParse(query)
        }

        // todo check for notNull fields so we dont hit the db

        v = Array.isArray(query.values) ? query.values : [query.values]
        if(v.length && v[0]) {
            const setKeys = Object.keys(v[0])
            for (const key of setKeys) {
                const field = this.fields[key]
                if (!field) throw new ProcessError('Invalid field ' + key)
            }
        }
    }

    protected async onDeleteParse(query: DeleteQuery) {
        if(query.returning) query.returning = this.checkColsWildcard(Array.isArray(query.returning) ? query.returning : [query.returning], this.data.allowWildcard ?? false)

        for (const ext of this.extensions) {
            ext.onDeleteParse && await ext.onDeleteParse(query, this.jc.globals.auth?.admin??false)
        }
    }

    protected async onUpdateParse(query: UpdateQuery) {
        const setKeys = Object.keys(query.set)
        for (const key of setKeys) {
            const field = this.fields[key]
            if(!field) throw new ProcessError('Invalid field ' + key)
            // if(field.usage && noUpdateSetUsages.includes(field.usage)) throw new ProcessError('Cannot update ' + key + ' field')
            if(field.noUpdate) throw new ProcessError('Cannot update ' + key + ' field')
        }
        // if(this.mapping.updated) query.set[this.mapping.updated] = {q: 'CURRENT_TIMESTAMP'}
        if(query.returning) query.returning = this.checkColsWildcard(Array.isArray(query.returning) ? query.returning : [query.returning], this.data.allowWildcard ?? false)

        for (const ext of this.extensions) {
            ext.onUpdateParse && await ext.onUpdateParse(query)
        }
    }

    protected async onSelectParse(query: SelectQuery) {
        // console.log('query', query)

        // todo make data.allowSubqueries and check
        const allowSubqueries = true

        query.selects = this.checkColsWildcard(
            Array.isArray(query.selects) ? query.selects : [query.selects || '*'],
            this.data.allowWildcard ?? false, allowSubqueries)

        this.handleSelectDeps(query)

        // extensions
        for (const ext of this.extensions) {
            ext.onSelectParse && await ext.onSelectParse(query)
        }
        await this.handleSelectSubQueries(query, allowSubqueries)
    }

    protected async onViewParse(query: SelectQuery, id: string) {
        // todo make data.allowSubqueries and check
        const allowSubqueries = true

        query.selects = this.checkColsWildcard(Array.isArray(query.selects) ? query.selects : [query.selects || '*'], this.data.allowWildcard ?? false, allowSubqueries)

        this.handleSelectDeps(query)

        for (const ext of this.extensions) {
            ext.onViewParse && await ext.onViewParse(query, id)
        }

        await this.handleSelectSubQueries(query, allowSubqueries)
    }

    private handleSelectDeps(query: SelectQuery) {
        // sql query dependencies. todo move to a function or extension
        const allQueries = [query.where, query.having].flat()
        for (const sqlQuery of allQueries) {
            if(!sqlQuery) continue
            const deps = (sqlQuery as SQLQuery).dependencies
            if (!deps?.length) continue

            for (const dep of deps) {
                if (dep.type === 'fts') {
                    const {table, column} = dep
                    if (table !== this.jc.tableName) throw new ProcessError('Invalid FTS dependency table ' + table)
                    if (!this.data.fullTextSearch || this.data.fullTextSearch.enabled === false) throw new ProcessError('FTS not available or disabled on table ' + table)
                    if (column && !this.data.fullTextSearch.fields.map(f => columnify(f)).includes(column)) throw new ProcessError('Invalid FTS column ' + column)
                    const content_rowid = this.data.fullTextSearch.content_rowid ?? 'rowid'
                    // add join
                    // SELECT main_table.uuid, main_table.content
                    // FROM main_table
                    // JOIN fts_table ON main_table.rowid = fts_table.rowid
                    // WHERE fts_table MATCH 'search_term';
                    const ftsTable = columnify(fts5TableName(this.name))
                    const join: SelectQueryJoin = {
                        table: ftsTable,
                        on: {q: `${columnify(this.name)}.${content_rowid} = ${ftsTable}.rowid`},
                    }
                    appendJoin(query, join)
                    appendOrderBy(query, `${ftsTable}.rank`)
                    continue
                }
                throw new ProcessError('Invalid SQLQuery dependency type ' + dep.type)
            }
        }
    }

    private async handleSelectSubQueries(query: SelectQuery, allowSubqueries: boolean) {
        const subQueries = getSubSelectQueries(query)
        for (const subQuery of subQueries) {
            if (!allowSubqueries) throw new ProcessError('Subqueries not allowed')
            if (typeof subQuery.from !== 'string') throw new ProcessError('Subquery from must be a string')
            const table = this.$db.table(uncolumnify(subQuery.from))
            if (!table) throw new ProcessError('Subquery table not found')
            await table.onSelectParse(subQuery) // todo use Promise.all? shouldnt matter actually
        }
    }

    // D1 Helpers

    private parseD1Error(e: D1Error){
        const msg: string = e?.errorMessage
        // todo check for other error types.
        // NOT NULL constraint failed: files.config: SQLITE_CONSTRAINT
        // FOREIGN KEY constraint failed: SQLITE_CONSTRAINT
        // UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT
        const errorMap = {
            'UNIQUE constraint failed': 'A record with this value already exists.',
            'NOT NULL constraint failed': 'This field cannot be NULL.',
            'FOREIGN KEY constraint failed': 'Unable to find related record (Foreign Key).',
        } as Record<string, string>
        const parts = msg.split(':').map(p=>p.trim())
        const column = parts.find(p=>{
            const c = p.split('.').pop()
            return c && this.fields[c]
        })?.split('.').pop()
        const mess = parts[0]
        if(column){
            const code = parts.pop()
            e.data = {
                [column]: {
                    code,
                    message: errorMap[mess] ?? mess,
                }
            }
        }else if(errorMap[mess]){
            e.message += ' - ' + errorMap[mess]
        }
    }

    async run<T>(q: SQLQuery, err: string){
        return this.$db.run<T>(q, err).catch(e=>{
            if(e instanceof D1Error) this.parseD1Error(e)
            throw e
        })
    }
    async transaction(q: SQLQuery[], err: string){
        return this.$db.transaction(q, err).catch(e=>{
            if(e instanceof D1Error) this.parseD1Error(e) // todo handle array error for transaction?
            throw e
        })
    }

    // R2 Helpers

    private async filesToDelete(desQuery: UpdateQuery|DeleteQuery, fileFields?: string[]) {
        if(!fileFields) fileFields = this.fileFields || []
        if (!fileFields.length) return undefined
        const selects = fileFields.map(f => `${desQuery.table}.${columnify(f)}`)
        const selectQuery = buildSelectQuery({
            from: desQuery.table,
            where: desQuery.where, // this will have the rule as well.
            selects,
            // limit: desQuery.limit,
            params: desQuery.params,
        }, this.jc.autoSimplifyExpr)
        const res = await this.run<any>(selectQuery, 'Failed to run select query')
        return res.flatMap(r => Object.values(r)).filter(v => !!v) as string[]
    }

    private filesToUpload(values: z.infer<typeof sqlValSchemaFile3>, filesToUpload?: Record<string, File>, filesToRef?: string[]) {
        filesToUpload = filesToUpload ?? {} as Record<string, File>
        filesToRef = filesToRef ?? [] as string[]
        if(!values || !this.fileFields) return {filesToUpload, filesToRef, values: sqlValSchemaRecord.parse(values)}
        const transformed: z.infer<typeof sqlValSchemaRecord> = {}
        for (const [key, val] of Object.entries(values)) {
            const isFileField = this.fileFields.includes(key)

            // ignore file field. This is done because file fields in html form set value to empty string when no file is set
            if (isFileField && val === '') continue

            if (!(val instanceof File)) {
                transformed[key] = val
            }
            if (!isFileField || val === null || val === undefined) continue

            // when deleting file, null should be passed. todo should we allow empty string as well? right now we are ignoring if empty string above
            // if(val === '') {
            //     transformed[key] = null
            //     continue
            // }

            if (typeof val === 'string') {
                if(this.allowMultipleFileRef){
                    // todo check if file exists?
                    const name = normalizeFileName(val, '')
                    // todo this will fail if normalizeFileName implementation changes, we should just check for the file in the bucket or could that open up for security issues?
                    if(name !== val) throw new ProcessError('Invalid file name ' + val)
                    // values[key] = name // not needed
                    filesToRef.push(name)
                    continue
                }

                // todo try to download file?
                throw new ProcessError('File URLs not supported. Set "allowMultipleFileRef" to refer to files from other records.')
            }
            if (val instanceof File) {
                const name = normalizeFileName(val.name)
                filesToUpload[name] = val
                transformed[key] = name
                continue
            }
            throw new ProcessError('File or string expected in file field')
        }
        return {filesToUpload, filesToRef, values: sqlValSchemaRecord.parse(transformed)}
    }

    fileRoute(key: string, recordId: string){
        // todo hardcoded api path
        return `/api/v1/files/${this.name}/${recordId}/${key}`
    }

    // todo record id like in pocketbase? not using right now because id can change which would break.
    fileKey(key: string, _recordId?: string){
        let basePath = this.data.r2Base/*??this.data.id*/??this.data.name
        if(this.data.idInR2) {
            if(!_recordId) throw new HTTPException(500, {message: 'Record id required when idInR2 is true'})
            basePath += '/' + _recordId
        }
        return `${basePath}/${key}`
    }

    async getFile(key: string, _recordId?: string){
        const fileKey = this.fileKey(key, _recordId)
        const object = await this.$db.getFileObject(fileKey).catch(e=> {
            console.error('Failed to get file', key, e)
            throw new HTTPException(500, {message: 'Failed to get file'});
        })
        if(!object) throw new HTTPException(404, {message: 'File not found'})
        return object
    }

    protected async _uploadFiles(files: Record<string, File>){
        const keys = Object.keys(files)
        if(!keys.length) return
        console.log('Uploading files', keys, files)
        const promises = keys.map(async (key)=>{
            const file = files[key]
            const res = await this.$db.putFileObject(this.fileKey(key), file, {
                httpMetadata: {
                    contentType: file.type || 'application/octet-stream',
                    cacheControl: 'public, max-age=31536000', // 1 year
                }
            }).catch(e=>{
                console.error('Failed to upload file', e)
                return null
            })
            if(!res) throw new HTTPException(500, { message: 'Failed to upload file ' + key + ' ' + file.name });
            return res
        })
        const res = await Promise.allSettled(promises)
        const hasError = res.some(r=>r.status === 'rejected')
        const successful: R2Object[] = res.filter(r=>r.status === 'fulfilled').map((r: any)=>r.value)
        if(hasError) {
            const errors = res.filter(r=>r.status === 'rejected').map((r: any)=>r.reason)
            console.error(errors)
            console.log('Deleting uploaded files', successful)
            await this.$db.deleteFileObject(successful.map(r=>r.key)).catch(e=>{
                console.error('Unable to delete some files after upload error', e)
                // todo mark for delete somehow in logs
            })
            throw new HTTPException(500, { message: 'Failed to upload files' });
        }
    }

    /**
     * Checks that all files referenced in a query exist
     * @param files
     * @protected
     */
    protected async _refCheckFiles(files: string[]){
        if(!files.length) return
        // todo add support for dry run mode in database, it would fail if allowMultipleFileRef is true

        if(!this.allowMultipleFileRef) throw new HTTPException(500, { message: 'Multiple file references shouldn\'t be allowed' });
        // console.log('Checking files', files)

        const promises = files.map(async (key)=>{
            const res = await this.$db.headFileObject(this.fileKey(key)).catch(e=>{
                console.error('Failed to check file', e)
                return undefined
            })
            if(res === undefined) throw new HTTPException(500, { message: 'Failed to check file ' + key });
            return res
        })
        const res = await Promise.allSettled(promises)
        const hasError = res.some(r=>r.status === 'rejected')
        const successful = res.filter(r=>r.status === 'fulfilled').map((r)=>r.value)
        if(!successful.length || hasError) {
            throw new HTTPException(500, { message: 'Failed to check files' });
        }
        if(successful.includes(null)){
            throw new HTTPException(400, { message: 'File not found ' + files[successful.indexOf(null)] });
        }
    }

    protected async _deleteFiles(files: string[]){
        const keys = files.map(f=>this.fileKey(f))
        if(!keys.length) return
        console.log('Deleting files', keys)
        return await this.$db.deleteFileObject(keys).catch(e=>{
            console.error('Failed to delete files', keys, e)
            // todo mark for delete somehow in logs, since this error below will be ignored
            throw new Error('Failed to delete files')
        })
    }

    // todo rename, as it also does other column checks
    checkColsWildcard(cols: SelectQuerySelect[], allowWildcard: boolean, allowSubqueries?: false): string[];
    checkColsWildcard(cols: SelectQuerySelect[], allowWildcard: boolean, allowSubqueries: true): SelectQuerySelect[];
    checkColsWildcard(cols: SelectQuerySelect[], allowWildcard: boolean, allowSubqueries = false) {
        const res = []
        // const hidden = this.jc.globals.auth?.admin ? [] : this.data.fields.filter(f=>!f.noSelect).map(f=>f.name)
        const isAdmin = !!this.jc.globals.auth?.admin
        // console.log('select ', cols, hidden)
        const aliases = new Set<string>()
        const addAlias = (alias: string)=>{
            if(aliases.has(alias)) throw new ProcessError('Duplicate field access ' + alias)
            aliases.add(alias)
        }
        for (const col of cols) {
            if(col === '*') {
                if(!allowWildcard/* || hidden.length*/) {
                    const fields = Object.entries(this.fields).filter(f => isAdmin || !f[1].noSelect)
                    const fieldsSql = fields.map(s => ident(s[0], this.jc))
                    res.push(...fieldsSql)
                    fields.forEach(f=> addAlias(f[0]))
                    continue;
                }
                res.push('*')
                addAlias('*')
                continue
            }
            if(typeof col === 'string' || typeof col.q === 'string') {
                const strCol = typeof col === 'string' ? col : col.q
                if (strCol.includes('*') && strCol !== 'COUNT(*)') throw new ProcessError('Invalid column ' + strCol)
                const alias = typeof col !== 'string' ? col.as ?? strCol : strCol
                addAlias(alias)
                // const column = col.split(' AS')[0]
                // if(hidden.includes(column)) throw new ProcessError('Cannot query ' + col)
            }else {
                if(!allowSubqueries) throw new ProcessError('Subqueries not allowed')
                if(!col.as) throw new Error('Subquery must have an alias')
                addAlias(col.as)
                // subquery
                // it will be checked in its own table
            }
            res.push(col)
        }
        // console.log(res)
        return res
    }

    // Routing

    private router: LinearRouter<RawRouterHandlerFunction> | undefined
    protected _routesInit = false
    private routes: HttpRoute[] = []

    protected _initRoutes(){
        if(!this.router) this.router = new LinearRouter()
        if(this._routesInit) return this.router

        this.routes.push(
            ...this.extensions.flatMap(e=>e.routes),
        )

        for (const route of this.routes) {
            this.router.add(route.method.toUpperCase(), route.path, this.$db.rawRouteHandler(route))
        }
        this._routesInit = true
        return this.router
    }

    async route(path: string){
        const router = this._initRoutes()
        const match = router.match(this.$db.c.req.method, path)
        const [handler, params] = match[0]?.[0] ?? [undefined]
        if(!handler) return undefined
        return await handler(params as Record<string, string>)
    }

    getRoutes(){
        this._initRoutes()
        return this.routes
    }

}

export const tableDeleteSchema = deleteSchema
export type TableDeleteParams = DeleteParams
export const tableInsertSchema = insertSchema.and(z.object({values: sqlValSchemaFile3}))
export type TableInsertParams =z.infer<typeof tableInsertSchema>
export const tableUpdateSchema = updateSchema.and(z.object({setValues: sqlValSchemaFile2}))
export type TableUpdateParams = z.infer<typeof tableUpdateSchema>
export const tableSelectSchema = selectSchema
export type TableSelectParams = SelectParams
export const tableViewSchema = selectSchema.pick({select: true})
export type TableViewParams = z.infer<typeof tableViewSchema>
