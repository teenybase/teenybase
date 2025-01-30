import {SQLLiteral, SQLQuery} from '../../types/sql'
import {SelectQuery} from './select'
import {InsertQuery} from './insert'
import {UpdateQuery} from './update'
import {DeleteQuery} from './delete'

export interface QueryTypes{
    select: SelectQuery
    insert: InsertQuery
    update: UpdateQuery
    delete: DeleteQuery
}

export type QueryType = keyof QueryTypes

/**
 * Warning - use only for logging, not for building queries.
 * @param query
 */
export function logSQLQuery(query: SQLQuery): string{
    if(typeof query.q !== 'string') query.q = JSON.stringify((query as any).l || query.q)
    const params = query.p ? Object.entries(query.p) : null
    let q = query.q.trim()
    if(params?.length) {
        for (const [k, val] of params) {
            let v = val

            // for d1. todo, should this be moved to literalToQuery
            if(v !== null && (typeof v === 'object' || Array.isArray(v))) {
                v = JSON.stringify(v)
            }

            q = q.replaceAll('{:' + k + '}', JSON.stringify(v))
        }
    }
    return q
}

// export function logSQLQuery2(query: SQLQuery): string{
//     const regex = /(?:^|\s|\W)\{\:([a-zA-Z0-9_]+)\}(?:\s|\W|$)/g
//     const matches = query.q.match(regex)
//     if(!matches?.length) return query.q
//     let {p, q} = query
//     for(const m1 of matches) {
//         const m = m1.trim()
//         const key = m.split('{:')[1].split('}')[0]
//         if(!p || p[key] === undefined) {
//             console.warn('Missing parameter', key, 'in params.', p)
//             throw new Error(`Missing parameter ${key} in params.`)
//         }
//         // for d1
//         let v = p[key]
//
//         // todo date
//
//         q = q.replace('{:'+key+'}', JSON.stringify(v))
//     }
//     return q.trim()
// }

const literalMapping = {
    0: '0',
    1: '1',
    true: '1',
    TRUE: '1',
    false: '0',
    FALSE: '0',
    null: 'NULL',
    NULL: 'NULL',
} as any

export function literalToQuery(l: SQLLiteral | SQLQuery | string, wrap = true): SQLQuery{
    let l1 = (l as SQLLiteral).l
    const isLiteral = l1 !== undefined
    const q = (l as SQLQuery).q
    if(!isLiteral && typeof l !== 'string'){
        if(typeof q !== 'string') throw new Error('Invalid query ' + JSON.stringify(l))
        return {
            // q: (!q || (q[0] === '(' && q[q.length - 1] === ')')) ? q : `(${q})`, // Note - this is wrong, since it could be like `(a) OR (b)` which should also be escaped.
            q: !q || !wrap ? q : `(${q})`, // tag - brackets
            p: (l as SQLQuery).p,
            dependencies: (l as SQLQuery).dependencies,
            _readOnly: (l as SQLQuery)._readOnly
        }
    }
    l1 = (isLiteral && typeof l === 'object') ? l1 : (l as string)
    let lm = typeof l1 !== "object" ? literalMapping[l1 as any] : undefined
    if(lm !== undefined) // apparently both m[true] and m['true'] resolves to 1 in js.
        return {q: lm, _readOnly: true}
    if(l1 === null || l1 === undefined) return {q: 'NULL', _readOnly: true}
    const rnd = 'f'+Math.random().toString(36).substring(7)
    return {
        q: '{:'+rnd+'}',
        p: { [rnd]: l1 }, // todo is object check required? right now it's done in sqlQueryToD1Query
        _readOnly: true
    }
}

// these are not useful, use applyBinaryOperator in jsep.ts
// function mergeSqlQueries(operator: string, ...queries: (SQLQuery|SQLLiteral)[]): SQLQuery{
//     // note - inside brackets are very important. todo make tests for this. todo how else can we ensure.
//     const q = '('+queries.map(query=>'('+query.q+')').join(' '+operator+' ')+')'
//     const p = queries.reduce((acc, query) => ({...acc, ...query.p}), {})
//     return {q, p}
// }
//
// export function andSqlQueries(...queries: (SQLQuery|SQLLiteral)[]): SQLQuery|SQLLiteral{
//     return mergeSqlQueries('AND', ...queries)
// }

