import {describe, expect, it} from 'vitest'
import {literalToQuery, logSQLQuery} from '../../src/sql/build/query'
import {buildInsertQuery} from '../../src/sql/build/insert'
import {buildUpdateQuery} from '../../src/sql/build/update'
import {sqlQueryToD1Query} from '../../src/sql/build/d1'
import {createFieldQuery} from '../../src/sql/schema/tableQueries'

// logSQLQuery output reaches D1Error.input, the query log and error responses. A sign-up INSERT
// carries the password hash and salt, so those literals must never be rendered - while still being
// bound to SQLite unchanged. See issues/resolved/error-response-leaks-sql-with-password-hash.md
const HASH = 'a2fe9c3113e3cb7d0133c63bc676d565b8255106ddddc8ca910fd27cb713e95a'
const SALT = 'cb8be680fafda6f9f0e4'

describe('logSQLQuery - redacted literals', () => {
    it('INSERT renders *** for a redacted value and keeps the rest', () => {
        const q = buildInsertQuery({
            table: '[users]',
            values: {name: {l: 'Bob'}, password: {l: HASH, redact: true}, password_salt: {l: SALT, redact: true}},
        } as any)
        const rendered = logSQLQuery(q)
        expect(rendered).toContain(`'***'`)
        expect(rendered).not.toContain(HASH)
        expect(rendered).not.toContain(SALT)
        expect(rendered).toContain('"Bob"')
    })
    it('the value still binds to SQLite unchanged', () => {
        const q = buildInsertQuery({table: '[users]', values: {password: {l: HASH, redact: true}}} as any)
        expect(sqlQueryToD1Query(q).v).toContain(HASH)
    })
    it('UPDATE SET renders *** for a redacted value', () => {
        const q = buildUpdateQuery({table: '[users]', set: {password: {l: HASH, redact: true}, name: {l: 'Bob'}}} as any)
        const rendered = logSQLQuery(q)
        expect(rendered).toContain(`'***'`)
        expect(rendered).not.toContain(HASH)
    })
    it('redactColumns marks a column even when the literal is not flagged', () => {
        // the schema-driven layer: any noSelect / password-usage column, with no auth extension involved
        const q = buildInsertQuery({table: '[t]', values: {secret: {l: HASH}, other: {l: 'x'}}} as any,
            true, true, new Set(['secret']))
        expect(logSQLQuery(q)).not.toContain(HASH)
        expect(sqlQueryToD1Query(q).v).toContain(HASH)
    })
    it('literalToQuery(redact) works for an appended WHERE comparison', () => {
        // the change-password flow appends `password = <current hash>` to the WHERE
        expect(logSQLQuery(literalToQuery({l: HASH, redact: true}))).toEqual(`'***'`)
        expect(logSQLQuery(literalToQuery({l: HASH}))).toContain(HASH)
    })
})

describe('logSQLQuery - unrelated call sites are untouched', () => {
    it('renders ordinary values verbatim', () => {
        const q = buildInsertQuery({table: '[t]', values: {a: {l: 'plain'}, b: {l: 42}}} as any)
        expect(logSQLQuery(q)).toContain('"plain"')
        expect(logSQLQuery(q)).toContain('42')
    })
    it('DDL generation still inlines defaults - redaction is opt-in per parameter', () => {
        // logSQLQuery also renders real migration SQL; a blanket redaction would corrupt schemas
        expect(createFieldQuery({name: 'x', type: 'text', sqlType: 'TEXT', default: {l: 'abc'}} as any))
            .toContain('"abc"')
    })
})
