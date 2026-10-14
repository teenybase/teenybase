import {describe, expect, it} from 'vitest'
import {zCustomError, formatZodError, validateSettingsChange, validateFieldChange, DatabaseSettings} from '../src'
import {authFields, baseFields} from '../src/scaffolds/fields'
import {z} from 'zod'

describe('Validation Error Handling', () => {
    it('should create a ZodError with structured path', () => {
        const error = zCustomError('Test error message', 'settings', 'tables', 'users', 'fields', 'email')

        expect(error).toBeInstanceOf(z.ZodError)
        expect(error.issues).toHaveLength(1)
        expect(error.issues[0].code).toBe('custom')
        expect(error.issues[0].message).toBe('Test error message')
        expect(error.issues[0].path).toEqual(['settings', 'tables', 'users', 'fields', 'email'])
    })

    it('should throw a validation error', () => {
        expect(() => {
            throw zCustomError('Field is required', 'table', 'users', 'fields', 'name')
        }).toThrow(z.ZodError)
    })

    it('should format validation errors with path', () => {
        const error = zCustomError('Field type is invalid', 'table', 'posts', 'fields', 'author_id', 'type')
        const formatted = formatZodError(error, 'Validation failed')

        expect(formatted).toContain('Validation failed')
        expect(formatted).toContain('table → posts → fields → author_id → type')
        expect(formatted).toContain('Field type is invalid')
    })

    it('should format multiple validation errors', () => {
        const error = new z.ZodError([
            {
                code: 'custom',
                message: 'Field name is required',
                path: ['table', 'users', 'fields', 0, 'name']
            },
            {
                code: 'custom',
                message: 'Field type is invalid',
                path: ['table', 'users', 'fields', 1, 'type']
            }
        ])

        const formatted = formatZodError(error)

        expect(formatted).toContain('table → users → fields → 0 → name')
        expect(formatted).toContain('Field name is required')
        expect(formatted).toContain('table → users → fields → 1 → type')
        expect(formatted).toContain('Field type is invalid')
    })
})

// --- base config for validation tests ---

const base: DatabaseSettings = {
    appUrl: 'https://localhost',
    jwtSecret: 'test-secret-1234567890',
    tables: [
        {
            name: 'posts',
            fields: [
                {name: 'id', sqlType: 'integer', type: 'integer', primary: true, autoIncrement: true},
                {name: 'title', sqlType: 'text', type: 'text'},
                {name: 'author_id', sqlType: 'integer', type: 'integer'},
            ],
            extensions: [],
        },
        {
            name: 'authors',
            fields: [
                {name: 'id', sqlType: 'integer', type: 'integer', primary: true, autoIncrement: true},
                {name: 'name', sqlType: 'text', type: 'text'},
            ],
            extensions: [],
        },
    ],
}

function clone<T>(obj: T): T { return JSON.parse(JSON.stringify(obj)) }

type IssueMatcher = {
    message?: string | RegExp
    path?: (string | number)[]
}

function expectIssues(fn: () => void, count: number, matchers?: (string | RegExp | IssueMatcher)[]) {
    try {
        fn()
        expect.unreachable('Expected ZodError')
    } catch (e) {
        expect(e).toBeInstanceOf(z.ZodError)
        const err = e as z.ZodError
        expect(err.issues).toHaveLength(count)
        if (matchers) {
            for (let i = 0; i < matchers.length; i++) {
                const m = matchers[i]
                if (typeof m === 'string') {
                    expect(err.issues[i].message).toContain(m)
                } else if (m instanceof RegExp) {
                    expect(err.issues[i].message).toMatch(m)
                } else {
                    if (m.message) {
                        if (typeof m.message === 'string') expect(err.issues[i].message).toContain(m.message)
                        else expect(err.issues[i].message).toMatch(m.message)
                    }
                    if (m.path) expect(err.issues[i].path).toEqual(m.path)
                }
            }
        }
        return err
    }
}

describe('validateSettingsChange errors test', () => {

    it('empty settings - 3 issues', () => {
        expectIssues(() => validateSettingsChange({} as any, undefined), 3, [
            {message: 'expected array', path: ['settings', 'tables']},
            {message: 'expected string', path: ['settings', 'jwtSecret']},
            {message: 'expected string', path: ['settings', 'appUrl']},
        ])
    })

    // --- 1 issue ---

    it('duplicate table name - 1 issue', () => {
        const c = clone(base)
        c.tables.push(clone(c.tables[0]))
        expectIssues(() => validateSettingsChange(c, undefined), 1, [
            {message: 'Duplicate table name', path: ['settings', 'tables']},
        ])
    })

    it('field type incompatible with sqlType - 1 issue', () => {
        const c = clone(base)
        c.tables[0].fields[1].type = 'integer' // text sqlType + integer type
        expectIssues(() => validateSettingsChange(c, undefined), 1, [
            {message: "Invalid type 'integer' for sqlType 'text'", path: ['settings', 'tables', 0, 'fields', 1, 'type']},
        ])
    })

    it('FK target table not found - 1 issue', () => {
        const c = clone(base)
        c.tables[0].fields[2].foreignKey = {table: 'nonexistent', column: 'id'}
        expectIssues(() => validateSettingsChange(c, undefined), 1, [
            {message: 'posts:author_id - Foreign key field not found - nonexistent.id', path: ['settings', 'tables']},
        ])
    })

    it('FK sqlType mismatch - 1 issue', () => {
        const c = clone(base)
        // author_id is integer, authors.name is text
        c.tables[0].fields[2].foreignKey = {table: 'authors', column: 'name'}
        expectIssues(() => validateSettingsChange(c, undefined), 1, [
            {message: 'posts:author_id - Foreign key field sqlType mismatch - integer !== text', path: ['settings', 'tables']},
        ])
    })

    it('allowWildcard not supported - 1 issue', () => {
        const c = clone(base)
        c.tables[0].allowWildcard = true
        expectIssues(() => validateSettingsChange(c, undefined), 1, [
            {message: 'allowWildcard is not supported', path: ['settings', 'tables', 0, 'allowWildcard']},
        ])
    })

    it('public: true combined with a rules extension - 1 issue', () => {
        const c = clone(base)
        c.tables[0].public = true
        c.tables[0].extensions = [{name: 'rules', listRule: 'true'}]
        expectIssues(() => validateSettingsChange(c, undefined), 1, [
            {message: "'public: true' cannot be combined with a rules extension", path: ['settings', 'tables', 0, 'public']},
        ])
    })

    it('public must be a boolean - 1 issue', () => {
        const c = clone(base) as any
        c.tables[0].public = 'yes'
        expectIssues(() => validateSettingsChange(c, undefined), 1, [
            {path: ['settings', 'tables', 0, 'public']},
        ])
    })

    it('auth table missing field usages - 3 issues', () => {
        const c: DatabaseSettings = {
            appUrl: 'https://localhost',
            jwtSecret: 'test-secret-1234567890',
            tables: [{
                name: 'users',
                autoSetUid: true,
                fields: [
                    ...baseFields,
                    {name: 'username', sqlType: 'text', type: 'text', unique: true},
                    {name: 'email', sqlType: 'text', type: 'text', unique: true},
                    {name: 'password', sqlType: 'text', type: 'text', noSelect: true},
                ],
                extensions: [{name: 'auth', passwordType: 'sha256', jwtSecret: 'users-secret', jwtTokenDuration: 3600, maxTokenRefresh: 4}],
            }],
        }
        expectIssues(() => validateSettingsChange(c, undefined), 3, [
            {message: "requires a field with usage 'auth_username'"},
            {message: "requires a field with usage 'auth_email'"},
            {message: "requires a field with usage 'auth_password'"},
        ])
    })

    it('auth table rejects required fields the auth insert path cannot populate - 1 issue', () => {
        const c: DatabaseSettings = {
            appUrl: 'https://localhost',
            jwtSecret: 'test-secret-1234567890',
            tables: [{
                name: 'users',
                autoSetUid: true,
                fields: [
                    ...baseFields,
                    ...authFields,
                    {name: 'plan', sqlType: 'text', type: 'text', notNull: true},
                ],
                extensions: [{name: 'auth', passwordType: 'sha256', jwtSecret: 'users-secret', jwtTokenDuration: 3600, maxTokenRefresh: 4}],
            }],
        }
        expectIssues(() => validateSettingsChange(c, undefined), 1, [
            {message: "cannot auto-populate NOT NULL field 'plan'", path: ['settings', 'tables', 0, 'fields', 12, 'notNull']},
        ])
    })

    // --- 2 issues ---

    it('two duplicate table pairs - 2 issues', () => {
        const c = clone(base)
        c.tables.push(clone(c.tables[0])) // dup posts
        c.tables.push(clone(c.tables[1])) // dup authors
        expectIssues(() => validateSettingsChange(c, undefined), 2, [
            {message: 'Duplicate table name', path: ['settings', 'tables']},
            {message: 'Duplicate table name', path: ['settings', 'tables']},
        ])
    })

    it('two FK targets not found across tables - 2 issues', () => {
        const c = clone(base)
        c.tables[0].fields[2].foreignKey = {table: 'missing1', column: 'id'}
        c.tables[1].fields.push({name: 'ref', sqlType: 'integer', type: 'integer', foreignKey: {table: 'missing2', column: 'id'}})
        expectIssues(() => validateSettingsChange(c, undefined), 2, [
            {message: 'posts:author_id - Foreign key field not found - missing1.id', path: ['settings', 'tables']},
            {message: 'authors:ref - Foreign key field not found - missing2.id', path: ['settings', 'tables']},
        ])
    })

    // --- 3+ issues ---

    it('idInR2 + allowMultipleFileRef + autoDeleteR2Files - 4 issues', () => {
        const c = clone(base)
        c.tables[0].idInR2 = true
        c.tables[0].allowMultipleFileRef = true
        c.tables[0].autoDeleteR2Files = true
        expectIssues(() => validateSettingsChange(c, undefined), 4, [
            {message: 'idInR2 requires', path: ['settings', 'tables', 0, 'idInR2']},
            {message: 'allowMultipleFileRef cannot be true when idInR2 is true', path: ['settings', 'tables', 0, 'allowMultipleFileRef']},
            {message: 'idInR2 cannot be true when allowMultipleFileRef is true', path: ['settings', 'tables', 0, 'idInR2']},
            {message: 'autoDeleteR2Files must be false when allowMultipleFileRef is true', path: ['settings', 'tables', 0, 'autoDeleteR2Files']},
        ])
    })

    it('drop 3 fields with usages - 3 issues', () => {
        const last = clone(base)
        last.tables[0].fields[0].usage = 'record_uid'
        last.tables[0].fields[1].usage = 'record_created'
        last.tables[0].fields[2].usage = 'record_updated'

        const next = clone(base)
        next.tables[0].fields = [] // drop all fields

        expectIssues(() => validateSettingsChange(next, last), 3, [
            {message: 'Field cannot be dropped - record_uid usage exists', path: ['settings', 'tables', 'posts', 'fields', 'id']},
            {message: 'Field cannot be dropped - record_created usage exists', path: ['settings', 'tables', 'posts', 'fields', 'title']},
            {message: 'Field cannot be dropped - record_updated usage exists', path: ['settings', 'tables', 'posts', 'fields', 'author_id']},
        ])
    })
})

describe('validateFieldChange error paths', () => {

    it('missing type and sqlType - throws proper error', () => {
        const field = {name: 'bad_field'} as any
        expectIssues(() => validateFieldChange(field, undefined, 'users', undefined, ['table']), 1, [
            {message: 'type or sqlType is required', path: ['table', 'fields', 'bad_field']},
        ])
    })

    it('FK target not found - correct path without duplication', () => {
        const field = {name: 'ref', sqlType: 'integer', type: 'integer', foreignKey: {table: 'missing', column: 'id'}} as any
        const settings = {tables: [{name: 'users', fields: [field]}]} as DatabaseSettings
        expectIssues(() => validateFieldChange(field, undefined, 'users', settings, ['table']), 1, [
            {message: 'Foreign key field not found - missing.id', path: ['table', 'fields', 'ref', 'foreignKey']},
        ])
    })

    it('FK sqlType mismatch - correct path without duplication', () => {
        const targetField = {name: 'id', sqlType: 'text', type: 'text'}
        const field = {name: 'ref', sqlType: 'integer', type: 'integer', foreignKey: {table: 'targets', column: 'id'}} as any
        const settings = {tables: [
            {name: 'users', fields: [field]},
            {name: 'targets', fields: [targetField]},
        ]} as DatabaseSettings
        expectIssues(() => validateFieldChange(field, undefined, 'users', settings, ['table']), 1, [
            {message: 'Foreign key field sqlType mismatch - integer !== text', path: ['table', 'fields', 'ref', 'foreignKey']},
        ])
    })
})
