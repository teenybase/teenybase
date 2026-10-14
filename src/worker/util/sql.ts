import {$Table} from '../$Table'
import {SQLQuery} from '../../types/sql'
import {D1Query} from '../../sql/build/d1'
import {QueryType, QueryTypes} from '../../sql/build/query'
import {EventInit} from '@cloudflare/workers-types'
import {D1Error} from './error'
import {PreparedQuery, QueryResult} from '../storage/StorageAdapter'

export interface SQLRunContext<TR = any, TRet = TR[]|any, QT extends QueryType = QueryType>{
    type: QT
    table: $Table
    crudQuery: QueryTypes[QT]
    query: SQLQuery
    errorMessage?: string

    onError?: (er: any) => Promise<any>
    onSuccess?: (res: QueryResult<TR>) => Promise<void> // any errors in onSuccess will be ignored.
    onRun?: () => Promise<void> // before run

    then?: (r: TR[]) => TRet | Promise<TRet>
}
export interface SQLRunTransactionContext<TR = any, TRet = TR[][]|any, QT extends QueryType = QueryType> extends Omit<SQLRunContext<TR, TRet, QT>, 'query' | 'crudQuery' | 'onSuccess' | 'then' | 'type'>{
    type: QT[]
    crudQuery: QueryTypes[QT][]
    query: SQLQuery[]
    /**
     *
     * @param r - has proper index as input
     */
    onSuccess?: (r: TR[][]) => Promise<void> // any errors in onSuccess will be ignored.

    then?: (r: TR[][]) => Promise<TRet>
}
export interface D1RunEventInput<TR=any> extends Partial<SQLRunContext<TR>>{
    d1Expr: D1Query
}
export interface D1PreparedQuery<TR = any, TRet = TR[], QT extends QueryType = QueryType>{
    prepared: PreparedQuery | null
    c: SQLRunContext<TR, TRet, QT> | undefined
    onError: (er: any, e1?: D1Error|undefined) => Promise<any>
    onSuccess: (res: QueryResult<TR>) => Promise<TR[]>
    // onRun: () => Promise<void> // before run

    run: () => Promise<TRet|null>
}
export interface D1PreparedTransaction<TR = any, TRet = TR[][], QT extends QueryType = QueryType>{
    prepared: (D1PreparedQuery<TR, TR[], QT> | D1PreparedTransaction<TR, TR[][], QT>)[]
    c: SQLRunTransactionContext<TR, TRet, QT> | undefined
    run: () => Promise<TRet|null>
}
export class D1RunEvent<TR = any> extends Event{
    public readonly input: D1RunEventInput<TR>
    public readonly result: QueryResult<TR>
    constructor(init: EventInit & {input: D1RunEventInput, result: QueryResult<TR>}) {
        super('run_sql', init)
        this.input = init.input
        this.result = init.result
    }
}
export class D1RunFailEvent<TR = any> extends Event{
    public readonly input: D1RunEventInput<TR>
    public readonly error: Error|any
    constructor(init: EventInit & {input: D1RunEventInput<TR>, error: Error|any, d1Error?: D1Error}) {
        super('run_sql_fail', init)
        this.input = init.input
        this.error = init.error
    }
}
