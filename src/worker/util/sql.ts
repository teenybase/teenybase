import {$Table} from '../$Table'
import {SQLQuery} from '../../types/sql'
import {D1Query} from '../../sql/build/d1'
import {QueryTypes} from '../../sql/build/query'

export interface SQLRunContext<T extends keyof QueryTypes = keyof QueryTypes>{
    type: T
    table: $Table
    crudQuery: QueryTypes[T]
    query: SQLQuery
}
export interface SQLRunTransactionContext<T extends keyof QueryTypes = keyof QueryTypes>{
    type: T
    table: $Table
    crudQuery: QueryTypes[T][]
    query: SQLQuery[]
}
export interface D1RunEventInput<T extends keyof QueryTypes = keyof QueryTypes> extends Partial<SQLRunContext<T>>{
    d1Expr: D1Query
}
export class D1RunEvent<T extends keyof QueryTypes = keyof QueryTypes, TR = any> extends Event{
    public readonly input: D1RunEventInput<T>
    public readonly result: D1Result<TR>
    constructor(init: EventInit & {input: D1RunEventInput<T>, result: D1Result<TR>}) {
        super('run_sql', init)
        this.input = init.input
        this.result = init.result
    }
}
export class D1RunFailEvent<T extends keyof QueryTypes = keyof QueryTypes> extends Event{
    public readonly input: D1RunEventInput<T>
    public readonly error: Error|any
    constructor(init: EventInit & {input: D1RunEventInput<T>, error: Error|any}) {
        super('run_sql_fail', init)
        this.input = init.input
        this.error = init.error
    }
}
