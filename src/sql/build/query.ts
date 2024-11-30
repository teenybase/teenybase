import {z} from 'zod'
import {sqlValSchema2} from '../../types/sql'

export interface SQLQuery{
    q: string,
    p?: Record<string, z.infer<typeof sqlValSchema2>>
}

export interface SQLLiteral<T=z.infer<typeof sqlValSchema2>> {
    l: T
    key?: string
}

/**
 * Warning - use only for logging, not for building queries.
 * @param query
 */
export function logSQLQuery(query: SQLQuery): string{
    const regex = /(?:^|\s|\W)\{\:([a-zA-Z0-9_]+)\}(?:\s|\W|$)/g
    const matches = query.q.match(regex)
    if(!matches?.length) return query.q
    let {p, q} = query
    for(const m1 of matches) {
        const m = m1.trim()
        const key = m.split('{:')[1].split('}')[0]
        if(!p || p[key] === undefined) {
            console.warn('Missing parameter', key, 'in params.', p)
            throw new Error(`Missing parameter ${key} in params.`)
        }
        // for d1
        let v = p[key]

        // todo date

        q = q.replace('{:'+key+'}', JSON.stringify(v))
    }
    return q
}

const literalMapping = {
    true: '1',
    TRUE: '1',
    false: '0',
    FALSE: '0',
    null: 'NULL',
    NULL: 'NULL',
} as any

export function literalToQuery(l: SQLLiteral | SQLQuery | string): SQLQuery{
    let l1 = (l as SQLLiteral).l
    const isLiteral = l1 !== undefined
    const q = (l as SQLQuery).q
    if(!isLiteral) {
        if(typeof q !== 'string') throw new Error('Invalid query')
        return {
            // q: (!q || (q[0] === '(' && q[q.length - 1] === ')')) ? q : `(${q})`, // Note - this is wrong, since it could be like `(a) OR (b)` which should also be escaped.
            q: !q ? q : `(${q})`, // tag - brackets
            p: (l as SQLQuery).p
        }
    }
    l1 = (isLiteral && typeof l === 'object') ? l1 : (l as string)
    if(literalMapping[l1 as any] !== undefined) // apparently both m[true] and m['true'] resolves to 1 in js.
        return {q: literalMapping[l1 as any]}
    if(l1 === null || l1 === undefined) return {q: 'NULL'}
    const rnd = 'f'+Math.random().toString(36).substring(7)
    return {
        q: '{:'+rnd+'}',
        p: { [rnd]: l1 } // is object check required?
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

