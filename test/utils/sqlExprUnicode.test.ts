import {describe, expect, test} from 'vitest'
import {sqlExprSchema} from '../../src/types/zod/sqlSchemas'
import {queryToSqlQuery} from '../../src/sql/parse/parse'
import {createJsepContext, emptyGlobals} from '../../src/sql/parse/jsep'
import {SQLQuery} from '../../src/types/sql'

// Regression: non-Latin / Unicode string literals in query expressions were rejected by sqlExprSchema's
// ASCII-only allowlist before reaching the parser (HTTP 400 "Invalid expression"). They are now accepted,
// while column/table identifiers stay ASCII-only and the literal value is bound as a SQL parameter.

describe('sqlExprSchema unicode literals', () => {
    const accept = [
        ['ascii', 'name="hello.glb" & path="/abc/"'],
        ['gujarati', 'name="પ્રથમ-bwr97p.glb"'], // includes U+0ACD virama (combining mark)
        ['chinese', 'name="测试文件.glb"'],
        ['japanese', 'name="日本語.glb"'],
        ['cjk-fullwidth-parens', 'name="文件（一）.glb"'], // \p{P} full-width parens
        ['jp-punctuation', 'name="メモ、テスト。.glb"'], // \p{P} CJK punctuation 、。
        ['arabic', 'name="ملف.glb"'],
        ['cyrillic', 'name="файл.glb"'],
        ['accented-latin', 'name="café.glb"'],
        ['emoji', 'name="file😀.glb"'], // \p{S} now allowed
        ['complex-bool', '(deleted = false || deleted = null) && created_by = "u1"'],
        ['braces-dollar', 'json_set(data, "$.a", "{x}")'], // \$\{\} still valid under the u flag
    ] as const
    for (const [name, expr] of accept) {
        test(`accepts ${name}`, () => expect(sqlExprSchema.safeParse(expr).success).toBe(true))
    }

    // Control characters are not letters/marks/numbers/punctuation/symbols/whitespace, so they stay rejected —
    // the pre-filter remains meaningful even though it now allows essentially all printable Unicode.
    const reject = [
        ['NUL', 'name="a\x00b"'],
        ['BEL', 'name="a\x07b"'],
        ['ESC', 'name="a\x1bb"'],
    ] as const
    for (const [name, expr] of reject) {
        test(`rejects control char ${name}`, () => expect(sqlExprSchema.safeParse(expr).success).toBe(false))
    }

    // Format characters (\p{Cf}) are not in the allowed classes either: bidi overrides can't be used to make
    // a rule read differently from what it does, and zero-width characters can't hide in a filter.
    const rejectFormat = [
        ['RLO U+202E', 'name="a\u202Eb"'],
        ['zero-width space U+200B', 'name="a\u200Bb"'],
        // also rejects joiners, so ZWJ emoji sequences and Persian ZWNJ don't pass (known limitation)
        ['zero-width joiner U+200D', 'name="a\u200Db"'],
        ['zero-width non-joiner U+200C', 'name="a\u200Cb"'],
    ] as const
    for (const [name, expr] of rejectFormat) {
        test(`rejects format char ${name}`, () => expect(sqlExprSchema.safeParse(expr).success).toBe(false))
    }

    function toSql(expr: string) {
        const jc = createJsepContext('files', [], emptyGlobals as any, ['files'])
        jc._checkColumns = false // skip column existence check for the isolated test
        return queryToSqlQuery(expr, jc) as SQLQuery
    }

    // \p{P} and \p{S} also admit ASCII punctuation the old allowlist did not (; [ ] ` ? # ^). The regex is
    // only a pre-filter: the parser has no construct for them, so they fail there and produce no SQL.
    const parserRejects = [
        ['statement separator', 'name="a"; DROP TABLE files'],
        ['array / computed member', 'name = [1]'],
        ['backtick', 'name = `x`'],
        ['ternary', 'name = "a" ? 1 : 2'],
        ['hash', 'name = #x'],
        ['xor', 'name ^ 1'],
    ] as const
    for (const [name, expr] of parserRejects) {
        test(`passes the pre-filter but the parser rejects ${name}`, () => {
            expect(sqlExprSchema.safeParse(expr).success).toBe(true)
            expect(() => toSql(expr)).toThrow()
        })
    }

    test('non-ASCII identifiers are still rejected (column names stay ASCII)', () => {
        expect(sqlExprSchema.safeParse('文件 = 1').success).toBe(true)
        expect(() => toSql('文件 = 1')).toThrow(/Table\/Column name/)
        expect(() => toSql('files.名前 = 1')).toThrow(/Table\/Column name/)
    })

    test('quote-like characters inside a literal stay in the bound value', () => {
        const value = `a＇b"c' OR 1=1 --`
        const sql = toSql(`name=${JSON.stringify(value)}`)
        expect(sql.q).not.toContain('OR 1=1')
        expect(Object.values(sql.p ?? {})).toContain(value)
    })

    test('safety: unicode literal is bound as a parameter, never interpolated into SQL', () => {
        const value = 'પ્રથમ-bwr97p.glb'
        const jc = createJsepContext('files', [], emptyGlobals as any, ['files'])
        jc._checkColumns = false // skip column existence check for the isolated test
        const sql = queryToSqlQuery(`name="${value}"`, jc) as SQLQuery
        // the raw unicode value must NOT appear in the SQL text...
        expect(sql.q.includes(value)).toBe(false)
        expect(sql.q).toMatch(/\[files\]\.\[name\]\) = \{:f[a-z0-9]+\}/)
        // ...it must live in the bound params instead
        expect(Object.values(sql.p ?? {})).toContain(value)
    })
})
