import {AuthContext} from '../types/env';
import {D1Query} from '../sql/build/d1';
import {
    D1PreparedQuery,
    D1PreparedTransaction,
    D1RunEvent,
    D1RunFailEvent,
    SQLRunContext,
    SQLRunTransactionContext
} from './util/sql';
import {logSQLQuery, QueryType} from '../sql/build/query';
import {D1Error, ProcessError} from './util/error';
import {StorageAdapter, PreparedQuery, QueryResult} from './storage/StorageAdapter';
import {D1Adapter} from './storage/D1Adapter';

export type $DatabaseEventMap = {
    // run_sql: D1RunEvent
    // run_sql_fail: D1RunFailEvent
}

export interface $DatabaseRaw/*<T extends $Env = $Env>*/{
    rawSQL<T>(d1Expr: D1Query, c?: SQLRunContext): D1PreparedQuery<any, T[]>
    rawSQLTransaction<T>(d1Expr: D1Query[], c?: SQLRunTransactionContext): D1PreparedTransaction<any, T[][]>
    auth: AuthContext
    // readonly settings: DatabaseSettings
    // readonly kv: InternalKV/*<T>*/
}

export class $DatabaseRawImpl extends EventTarget<$DatabaseEventMap> implements $DatabaseRaw {
    protected dryRunMode = false
    protected readOnlyMode = false
    readonly adapter: StorageAdapter

    // TODO: Remove D1Database acceptance once multiple adapters exist (for tree-shaking)
    constructor(adapter: StorageAdapter | D1Database) {
        super()
        this.adapter = 'run' in adapter && 'runBatch' in adapter ? adapter : 'prepare' in adapter ? new D1Adapter(adapter as D1Database) : adapter
    }

    auth: AuthContext = {
        jwt: {}, verified: false, admin: false,
        uid: null, sid: null, role: null, email: null,
        meta: {}, cid: null, superadmin: false,
    }

    rawSQL<T>(d1Expr: D1Query, c?: SQLRunContext): D1PreparedQuery<any, T[]> {
        return this._prepareD1Query<T>(d1Expr, false, c)
    }

    rawSQLTransaction<T>(d1Expr: D1Query[], c?: SQLRunTransactionContext): D1PreparedTransaction<any, T[][]> {
        return this._prepareD1Transaction<T>(d1Expr, false, c)
    }

    onRunSQL: ((e: D1RunEvent) => void | Promise<void>) [] = []
    onRunFailSQL: ((e: D1RunFailEvent) => void | Promise<void>) [] = []

    protected _prepareD1Query<T, TRet = T[], TC extends QueryType = QueryType>(d1Expr: D1Query, readOnly = true, c?: SQLRunContext<T, TRet, TC>) {
        if (this.readOnlyMode && !readOnly) throw new ProcessError('Running raw SQL is not allowed in read only mode.')
        if (this.dryRunMode) throw new ProcessError('Running raw SQL is not allowed in dry run.')
        const prep: D1PreparedQuery<T, TRet, TC> = {
            prepared: d1Expr.q ? new PreparedQuery(d1Expr.q, d1Expr.v) : null,
            c,
            onError: async (er: any, er2?: D1Error | any) => {
                // todo only dispatch event if the error is from this query in transaction, right now D1 is not providing this information
                // throw new HTTPException(500, { message: err??'Error running transaction' });
                const e = er2 instanceof D1Error ? er2 : new D1Error(prep.c?.errorMessage || 'SQL Error',
                    er.message ? er.message.replace(/D1_ERROR: /g, '') : 'Unknown error when running sql', er, prep.c?.query ? logSQLQuery(prep.c.query) : '')
                const error = prep.c?.table?.parseD1Error(e) ?? e
                const event = (new D1RunFailEvent({input: {...prep.c, d1Expr}, error: er, d1Error: error}))

                for (const listener of this.onRunFailSQL) await listener(event)
                return c?.onError ? c.onError(error) : error
            },
            onSuccess: async (res): Promise<T[]> => {
                if (!res) throw new Error('Unknown error - No result')
                else if (!res.success) throw new Error(res.error)
                else {
                    // console.log('Query result:', res)
                    const event = (new D1RunEvent({input: {...prep.c, d1Expr}, result: res}))
                    for (const listener of this.onRunSQL) await listener(event)
                    c?.onSuccess && await c.onSuccess(res)
                    return res.results
                }
            },

            run: async () => {
                // if((this.c.env as any).IS_VITEST){
                //     console.log('Executing SQL:', d1Expr)
                // }
                return this._exec(prep)
            }
        }
        return prep
    }

    protected _prepareD1Transaction<T, TRet = T[][], TC extends QueryType = QueryType>(d1Exprs: D1Query[], readOnly = false, c?: SQLRunTransactionContext<T, TRet, TC>): D1PreparedTransaction<T, TRet, TC> {
        const prepared = d1Exprs.map((query, i) => {
            return this._prepareD1Query<T, T[], TC>(query, readOnly, c ? {
                ...c,
                query: c.query[i],
                crudQuery: c.crudQuery[i],
                type: c.type[i],
                onError: undefined,
                onSuccess: undefined,
                onRun: undefined,
                then: undefined,
            } : undefined)
        })
        const prep = {
            prepared,
            c,
            run: async () => {
                // if((this.c.env as any).IS_VITEST){
                //     console.log('Executing SQL Transaction:', d1Exprs)
                // }
                return this._execBatch(prep)
            }
        } as D1PreparedTransaction<T, TRet, TC>
        return prep
    }

    protected async _exec<T, TRet = T[]>(prep: D1PreparedQuery<T, TRet>): Promise<TRet | null> {
        let res
        try {
            prep.c?.onRun && await prep.c.onRun()
            res = prep.prepared
                ? await this.adapter.run<T>(prep.prepared.q, prep.prepared.v)
                : undefined
        } catch (e) {
            throw await prep.onError(e)
        }
        let ret
        try {
            ret = await prep.onSuccess(res ?? {success: true, results: []})
        } catch (e) {
            console.error('Unknown error in onSuccess', res, e)
            ret = res?.results || []
        }
        try {
            // @ts-expect-error TS2322 unavoidable
            return prep.c?.then ? await prep.c.then(ret) : ret
        } catch (e) {
            console.error('Unknown error in then, ignored', ret, e)
            return null
        }
    }

    protected async _execBatch<T = any, TRet = T[][]>(transaction: D1PreparedTransaction<T, TRet>): Promise<TRet | null> {
        const queries: PreparedQuery[] = []
        const onRuns: (() => Promise<void>)[] = []
        const onErrors: ((e: any, e1?: D1Error|undefined) => any)[] = []

        function collect(t: D1PreparedTransaction<T, TRet>) {
            t.c?.onRun && onRuns.push(t.c.onRun)
            t.c?.onError && onErrors.push(t.c.onError)
            for (const prep of t.prepared) {
                if (Array.isArray(prep.prepared)) {
                    collect(prep as D1PreparedTransaction<T, TRet>)
                } else if (prep.prepared) {
                    const prep1 = prep as D1PreparedQuery<T, TRet>;
                    prep.c?.onRun && onRuns.push(prep.c.onRun)
                    prep1.onError && onErrors.push(prep1.onError)
                    queries.push(prep.prepared)
                }
            }
        }

        collect(transaction)

        let res: QueryResult<T>[]
        try {
            for (const onRun of onRuns) { // todo promise.all in batch?
                await onRun()
            }
            // `queries` holds PreparedQuery instances. `StorageAdapter.runBatch` is typed as the
            // plain `{q, v}` shape and PreparedQuery is structurally compatible, so an in-process
            // adapter takes either — but an adapter can be a Workers RPC stub (an RPC storage
            // adapter in another worker), and workerd's serializer refuses application-defined class
            // instances with `Could not serialize object of type "PreparedQuery"`. Flatten to plain
            // objects (and the frozen readonly array to a plain one) before the call can cross a boundary.
            res = queries.length
                ? await this.adapter.runBatch<T>(queries.map(p => ({q: p.q, v: Array.from(p.v)})))
                : []
        } catch (e) {
            // throw e
            // console.error(e)
            // todo figure out a better error format after parsing D1Error, like CompoundD1Error, but in batch operation there would only be one error, and we could have some results from some statements, and error with statement index etc.
            // todo create test for error from a batch transaction fail, doesn't look like there is any yet.
            const res1 = []
            let d1Error: D1Error | undefined = undefined
            for (const onError of onErrors) {
                try {
                    let res2 = await onError(e, d1Error)
                    if(res2 && res2 !== d1Error) res1.push(res2)
                    if(res2 && res2 instanceof D1Error)
                        d1Error = res2
                } catch (e1) {
                    console.error('Unknown error in onError', e1)
                    // e = e1
                    res1.push(e1)
                }
            }
            if(res1.length === 1)
                throw res1[0]
            throw new ProcessError('D1Errors - Multiple errors when executing sql transaction', 400, {errors: res1}, e)
        }
        let i = 0

        async function collectResults(t: D1PreparedTransaction<T, TRet>) {
            let res2: T[][] = []
            for (const prep1 of t.prepared) {
                if (Array.isArray(prep1.prepared)) {
                    const prep = prep1 as D1PreparedTransaction<T, TRet>
                    const res3 = await collectResults(prep)
                    if (Array.isArray(res3)) {
                        res2.push(...res3)
                    } else {
                        console.error('Invalid result in nested transaction, expected array, ignored', res3)
                        // res2.push()
                    }
                } else {
                    const prep = prep1 as D1PreparedQuery<T, T[], 'select'>;
                    const r: QueryResult<T> = prep.prepared ? res[i++] : {success: true, results: []}
                    let ret: T[]
                    try {
                        ret = await prep.onSuccess(r)
                    } catch (e) {
                        console.error('Unknown error in onSuccess, ignored', r, e)
                        ret = r?.results || []
                    }
                    try {
                        res2.push(prep.c?.then ? await prep.c.then(ret) : ret)
                    } catch (e) {
                        console.error('Unknown error in then, ignored', ret, e)
                        // res2.push(null)
                    }
                }
            }
            try {
                t.c?.onSuccess && await t.c.onSuccess(res2)
            } catch (e) {
                console.error('Unknown error in onSuccess, ignored', res, e)
            }
            try {
                return (t.c?.then ? await t.c.then(res2) : res2) as TRet
            } catch (e) {
                console.error('Unknown error in then, ignored', res2, e)
                return null
            }
        }

        return await collectResults(transaction)
    }

}
