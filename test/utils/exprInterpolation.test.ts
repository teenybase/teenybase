import {describe, expect, test} from 'vitest'
import {queryToSqlQuery} from '../../src/sql/parse/parse'
import {literalToQuery} from '../../src'
import {createJsepContext, emptyGlobals} from '../../src/sql/parse/jsep'

// Building an expression from user input: literals are always bound as parameters (no SQL injection),
// but a raw value can still end the string literal and change what the expression means. Quoting the
// value with JSON.stringify keeps it a single string literal (docs/config-reference.md, Expression Syntax).

const compile = (input: string) => {
    const jc = createJsepContext('users', [], {...emptyGlobals, auth: {...emptyGlobals.auth, role: 'user', sid: 'test'}}, ['users'], undefined, true, true)
    jc._checkColumns = false
    return literalToQuery(queryToSqlQuery(input, jc))
}

const hostile = `x' | email != '`

describe('interpolating user input into an expression', () => {
    test('a raw value can change the expression (it stays parameterized SQL)', () => {
        const q = compile(`email == '${hostile}'`)
        // the input closed the literal and added an OR branch: two bound values instead of one
        expect(Object.keys(q.p ?? {}).length).toBe(2)
        expect(q.q).toContain(' OR ')
    })

    test('JSON.stringify keeps the value one bound string literal', () => {
        const q = compile(`email == ${JSON.stringify(hostile)}`)
        expect(Object.values(q.p ?? {})).toEqual([hostile])
        expect(q.q).not.toContain(' OR ')
    })

    test('JSON.stringify also handles backslashes, double quotes and non-Latin text', () => {
        for (const v of [`a\\b`, `say "hi"`, `it's`, '文件（一）']) {
            const q = compile(`name == ${JSON.stringify(v)}`)
            expect(Object.values(q.p ?? {})).toEqual([v])
        }
    })
})
