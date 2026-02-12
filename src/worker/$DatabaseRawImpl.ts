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
    protected readonly database: D1Database

    constructor(database: D1Database) {
        super()
        this.database = database
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
            prepared: d1Expr.q ? this.database.prepare(d1Expr.q).bind(...d1Expr.v) : null,
            c,
            onError: async (er: any) => {
                // todo only dispatch event if the error is from this query in transaction
                const msg = er.message ? er.message.replace(/D1_ERROR: /g, '') : 'Unknown error'
                // throw new HTTPException(500, { message: err??'Error running transaction' });
                const e = new D1Error(prep.c?.errorMessage || 'Unknown SQL Error', msg, er, prep.c?.query ? logSQLQuery(prep.c.query) : '')
                const error = prep.c?.table?.parseD1Error(e) ?? e
                const event = (new D1RunFailEvent({input: {...prep.c, d1Expr}, error: er}))
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

    protected async _exec<T, TRet = T[]>(prep: D1PreparedQuery<T, TRet>): Promise<TRet | null> {
        let res
        try {
            prep.c?.onRun && await prep.c.onRun()
            res = await prep.prepared?.run<T>()
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
        const statements: D1PreparedStatement[] = []
        const onRuns: (() => Promise<void>)[] = []
        const onErrors: ((e: any) => any)[] = []

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
            res = statements.length ? await this.database.batch<T>(statements) : []
        } catch (e) {
            for (const onError of onErrors) {
                try {
                    e = await onError(e)
                } catch (e1) {
                    console.error('Unknown error in onError', e1)
                    e = e1
                }
            }
            throw e
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
                    const r = prep.prepared ? res[i++] : ({success: true, results: []} as Omit<D1Result<T>, 'meta'>)
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
