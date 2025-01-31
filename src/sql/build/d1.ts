import {SQLQuery} from '../../types/sql'

export interface D1Query{
    q: string,
    v: any[]
}

// todo check cf when they support named parameters - https://developers.cloudflare.com/d1/worker-api/prepared-statements/#guidance
// todo benchmark and optimise, might be slow when inserting lots of values
export function sqlQueryToD1Query(query: SQLQuery): D1Query{
    if(!query.p) return {q: query.q, v: []}
    const regex = /(?:^|\s|\W)\{\:([a-zA-Z0-9_]+)\}(?:\s|\W|$)/g
    const matches = query.q.match(regex)
    if(!matches?.length) return {q: query.q, v: []}
    let {p, q} = query
    const vals = []
    for(const m1 of matches) {
        const m = m1.trim()
        const key = m.split('{:')[1].split('}')[0]
        let v = p?.[key]
        if(v === undefined) {
            console.warn('Missing parameter', key, 'in params.', q, p)
            throw new Error(`Missing parameter ${key} in params.`)
        }
        q = q.replace('{:'+key+'}', '?')

        // for d1. todo, should this be moved to literalToQuery
        if(v !== null && (typeof v === 'object' || Array.isArray(v))) {
            v = JSON.stringify(v)
        }

        vals.push(v)
    }
    return {q, v: vals}
}

