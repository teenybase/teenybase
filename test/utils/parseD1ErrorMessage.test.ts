import {describe, expect, it} from 'vitest'
import {parseD1ErrorMessage} from '../../src/worker/util/error'

// These run in the node vitest project, with no workers pool — deliberately. The pool pins its own
// workerd (1.20260310.1 at the time of writing), which predates the 2026-03-19 change that started
// appending the extended result code, so a worker test physically cannot observe the message format
// every deployed worker produces. Both formats are pinned here instead.
const isField = (n: string) => ['uid', 'username', 'name', 'email', 'a', 'b', 'config'].includes(n)

describe('parseD1ErrorMessage - pre-2026-03-19 workerd format', () => {
    it('UNIQUE', () => {
        expect(parseD1ErrorMessage('UNIQUE constraint failed: users.uid: SQLITE_CONSTRAINT', isField)).toEqual({
            columns: ['uid'],
            code: 'SQLITE_CONSTRAINT',
            extendedCode: undefined,
            constraint: 'UNIQUE',
            mapped: 'A record with this value already exists.',
            head: 'UNIQUE constraint failed',
        })
    })
    it('NOT NULL', () => {
        const p = parseD1ErrorMessage('NOT NULL constraint failed: users.name: SQLITE_CONSTRAINT', isField)
        expect(p).toMatchObject({columns: ['name'], code: 'SQLITE_CONSTRAINT', constraint: 'NOT NULL'})
        expect(p.extendedCode).toBeUndefined()
    })
    it('FOREIGN KEY names no column', () => {
        expect(parseD1ErrorMessage('FOREIGN KEY constraint failed: SQLITE_CONSTRAINT', isField))
            .toMatchObject({columns: [], code: 'SQLITE_CONSTRAINT', mapped: 'Foreign Key constraint failed.'})
    })
})

describe('parseD1ErrorMessage - post-2026-03-19 workerd format (extended result code)', () => {
    it('strips " (extended: X)" and exposes it as extendedCode', () => {
        expect(parseD1ErrorMessage(
            'UNIQUE constraint failed: users.username: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)', isField))
            .toMatchObject({
                columns: ['username'],
                code: 'SQLITE_CONSTRAINT',
                extendedCode: 'SQLITE_CONSTRAINT_UNIQUE',
                constraint: 'UNIQUE',
            })
    })
    it('never leaks the closing paren into code - the regression', () => {
        const p = parseD1ErrorMessage(
            'NOT NULL constraint failed: users.name: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL)', isField)
        expect(p.code).toEqual('SQLITE_CONSTRAINT')
        expect(p.code).not.toContain(')')
        expect(p.extendedCode).toEqual('SQLITE_CONSTRAINT_NOTNULL')
    })
    it('PRIMARYKEY extended code on a UNIQUE message', () => {
        expect(parseD1ErrorMessage(
            'UNIQUE constraint failed: users.uid: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)', isField)
            .extendedCode).toEqual('SQLITE_CONSTRAINT_PRIMARYKEY')
    })
    it('errorMessage-style suffix does not disturb the human message', () => {
        expect(parseD1ErrorMessage(
            'UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)', isField)
            .mapped).toEqual('A record with this value already exists.')
    })
})

describe('parseD1ErrorMessage - extended code as the tail, with no wrapper', () => {
    // Defensive: no runtime has been observed emitting this shape. Raised by a reviewer of the
    // ijewel/template-core port of this fix, citing better-sqlite3. Cheap insurance - without it an
    // EXTENDED code sits in the primary-code field and a consumer comparing against
    // SQLITE_CONSTRAINT still misses, which is the class of bug this whole change is about.
    it('decomposes SQLITE_CONSTRAINT_NOTNULL into primary + extended', () => {
        expect(parseD1ErrorMessage('NOT NULL constraint failed: users.name: SQLITE_CONSTRAINT_NOTNULL', isField))
            .toMatchObject({
                columns: ['name'],
                code: 'SQLITE_CONSTRAINT',
                extendedCode: 'SQLITE_CONSTRAINT_NOTNULL',
                constraint: 'NOT NULL',
            })
    })
    it('handles a multi-token extended name', () => {
        // every SQLite PRIMARY code is SQLITE_<one token>, so 3+ tokens is unambiguously extended
        expect(parseD1ErrorMessage('no such column: x: SQLITE_ERROR_MISSING_COLLSEQ', isField))
            .toMatchObject({code: 'SQLITE_ERROR', extendedCode: 'SQLITE_ERROR_MISSING_COLLSEQ'})
    })
    it('leaves a bare primary code alone', () => {
        const p = parseD1ErrorMessage('UNIQUE constraint failed: users.uid: SQLITE_CONSTRAINT', isField)
        expect(p.code).toEqual('SQLITE_CONSTRAINT')
        expect(p.extendedCode).toBeUndefined()
    })
    it('an explicit (extended: X) wrapper still wins', () => {
        expect(parseD1ErrorMessage(
            'UNIQUE constraint failed: users.uid: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)', isField))
            .toMatchObject({code: 'SQLITE_CONSTRAINT', extendedCode: 'SQLITE_CONSTRAINT_UNIQUE'})
    })
})

describe('parseD1ErrorMessage - sqlite3_error_offset suffix', () => {
    // The offset is appended to the end of the raw errmsg, i.e. onto the `table.column` segment.
    // Left in place it defeats column detection entirely.
    it('still finds the column when " at offset N" trails it', () => {
        expect(parseD1ErrorMessage(
            'NOT NULL constraint failed: files.config at offset 12: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL)', isField))
            .toMatchObject({
                columns: ['config'],
                code: 'SQLITE_CONSTRAINT',
                constraint: 'NOT NULL',
                mapped: 'This field cannot be NULL.',
            })
    })
    it('leaves a non-constraint message alone', () => {
        expect(parseD1ErrorMessage('no such column: foo at offset 7: SQLITE_ERROR', isField))
            .toMatchObject({columns: [], code: 'SQLITE_ERROR', head: 'no such column', mapped: undefined})
    })
})

describe('parseD1ErrorMessage - composite unique index', () => {
    it('reports every named column, in both formats', () => {
        expect(parseD1ErrorMessage('UNIQUE constraint failed: users.a, users.b: SQLITE_CONSTRAINT', isField).columns)
            .toEqual(['a', 'b'])
        expect(parseD1ErrorMessage(
            'UNIQUE constraint failed: users.a, users.b: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)', isField)
            .columns).toEqual(['a', 'b'])
    })
})

describe('parseD1ErrorMessage - storage adapters (message prefixed, no result code)', () => {
    // These adapters prepend their class name and discard the structured code their backend sends.
    // `code` must come back undefined rather than picking up `users.uid` - issues/open/storage-adapter-error-normalization.md
    for (const m of [
        'D1HttpAdapter: UNIQUE constraint failed: users.uid',
        'D1HttpAdapter: HTTP 500: UNIQUE constraint failed: users.uid',
        'D1RestAdapter: batch[0] failed: UNIQUE constraint failed: users.uid',
        'LibsqlAdapter: UNIQUE constraint failed: users.uid',
    ]) it(`does not mistake the column segment for a code - ${m}`, () => {
        const p = parseD1ErrorMessage(m, isField)
        expect(p.columns).toEqual(['uid'])
        expect(p.code).toBeUndefined()
    })
})

describe('parseD1ErrorMessage - degenerate input', () => {
    it('empty / non-string', () => {
        expect(parseD1ErrorMessage('', isField)).toEqual({columns: [], head: ''})
        expect(parseD1ErrorMessage(undefined as any, isField)).toEqual({columns: [], head: ''})
    })
    it('plain message with no column or code', () => {
        expect(parseD1ErrorMessage('Unknown error when running sql', isField))
            .toMatchObject({columns: [], code: undefined, head: 'Unknown error when running sql'})
    })
    it('ignores columns that are not fields of this table', () => {
        expect(parseD1ErrorMessage('UNIQUE constraint failed: other.not_a_field: SQLITE_CONSTRAINT', isField).columns)
            .toEqual([])
    })
})
