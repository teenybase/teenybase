import {describe, expect, it} from 'vitest'
import {isUniqueViolationOn, sqlErrorText} from '../../src/worker/util/sqlConstraintError'
import {D1Error, ProcessError} from '../../src/worker/util/error'

// Runs in the node vitest project, with no workers pool - deliberately. The pool pins its own
// workerd (1.20260310.1), which predates the 2026-03-19 change that started appending the extended
// result code, so no worker test can produce the message format a deployed worker actually returns.
const OLD = 'UNIQUE constraint failed: users.username: SQLITE_CONSTRAINT'
const NEW = 'UNIQUE constraint failed: users.username: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)'

describe('isUniqueViolationOn - message formats', () => {
    it('matches the pre-2026-03-19 format', () => {
        expect(isUniqueViolationOn({errorMessage: OLD}, 'username')).toBe(true)
    })
    it('matches the post-2026-03-19 extended-code format', () => {
        // This is the case that was false in production and killed the OAuth username retry.
        expect(isUniqueViolationOn({errorMessage: NEW}, 'username')).toBe(true)
    })
    it('matches with an " at offset N" suffix', () => {
        expect(isUniqueViolationOn({errorMessage:
            'UNIQUE constraint failed: users.username at offset 12: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)'},
            'username')).toBe(true)
    })
    it('matches a composite index naming the column', () => {
        expect(isUniqueViolationOn({errorMessage: 'UNIQUE constraint failed: users.a, users.username: SQLITE_CONSTRAINT'},
            'username')).toBe(true)
    })
})

describe('isUniqueViolationOn - storage adapter messages', () => {
    for (const m of [
        'D1HttpAdapter: UNIQUE constraint failed: users.email',
        'D1HttpAdapter: HTTP 500: UNIQUE constraint failed: users.email',
        'D1RestAdapter: batch[0] failed: UNIQUE constraint failed: users.email',
        'LibsqlAdapter: UNIQUE constraint failed: users.email',
    ]) it(`matches ${m}`, () => {
        expect(isUniqueViolationOn(new Error(m), 'email')).toBe(true)
    })
})

describe('isUniqueViolationOn - column anchoring', () => {
    it('does not match a longer column with the same prefix', () => {
        expect(isUniqueViolationOn({errorMessage: 'UNIQUE constraint failed: users.username_lower: SQLITE_CONSTRAINT'},
            'username')).toBe(false)
        expect(isUniqueViolationOn({errorMessage: 'UNIQUE constraint failed: users.user_handle: SQLITE_CONSTRAINT'},
            'user')).toBe(false)
    })
    it('email does not match email_verified', () => {
        expect(isUniqueViolationOn({errorMessage: 'UNIQUE constraint failed: users.email_verified: SQLITE_CONSTRAINT'},
            'email')).toBe(false)
    })
    it('an email collision is not a username collision', () => {
        expect(isUniqueViolationOn({errorMessage: 'UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT'},
            'username')).toBe(false)
    })
    it('regex metacharacters in a column name are escaped', () => {
        expect(isUniqueViolationOn({errorMessage: 'UNIQUE constraint failed: users.a+b: SQLITE_CONSTRAINT'}, 'a+b')).toBe(true)
        expect(isUniqueViolationOn({errorMessage: 'UNIQUE constraint failed: users.axb: SQLITE_CONSTRAINT'}, 'a+b')).toBe(false)
    })
})

describe('isUniqueViolationOn - error shapes', () => {
    it('reads D1Error.errorMessage, not its label', () => {
        const e = new D1Error('Failed to run insert query', NEW, undefined)
        expect(sqlErrorText(e)).toEqual(NEW)
        expect(isUniqueViolationOn(e, 'username')).toBe(true)
    })
    it('prefers data.error once parseD1Error has run', () => {
        const e = new D1Error('Failed to run insert query', NEW, undefined)
        e.data = {username: {code: 'SQLITE_CONSTRAINT', message: 'x', errorMessage: NEW, constraint: 'UNIQUE'}}
        expect(sqlErrorText(e)).toEqual(NEW)
        expect(isUniqueViolationOn(e, 'username')).toBe(true)
    })
    it('does NOT scan data.input - the rendered statement names every column', () => {
        const e = new D1Error('Failed to run insert query', 'NOT NULL constraint failed: users.name: SQLITE_CONSTRAINT',
            undefined, 'INSERT INTO [users] ([username], [email]) VALUES ("a", "b") -- users.username')
        expect(isUniqueViolationOn(e, 'username')).toBe(false)
    })
    it('walks the cause chain', () => {
        const inner = new D1Error('Failed to run insert query', NEW, undefined)
        expect(isUniqueViolationOn(new ProcessError('wrapped', 400, {}, inner), 'username')).toBe(true)
    })
    it('plain strings work', () => {
        expect(isUniqueViolationOn(NEW, 'username')).toBe(true)
    })
    it('non-unique constraints and junk return false', () => {
        expect(isUniqueViolationOn({errorMessage: 'NOT NULL constraint failed: users.username: SQLITE_CONSTRAINT'},
            'username')).toBe(false)
        expect(isUniqueViolationOn({errorMessage: 'FOREIGN KEY constraint failed'}, 'username')).toBe(false)
        expect(isUniqueViolationOn(undefined, 'username')).toBe(false)
        expect(isUniqueViolationOn(null, 'username')).toBe(false)
        expect(isUniqueViolationOn({errorMessage: NEW}, undefined)).toBe(false)
        expect(isUniqueViolationOn({errorMessage: NEW}, '')).toBe(false)
    })
})
