import {describe, expect, it} from 'vitest'
import {assertTablesHaveAccessPolicy, DatabaseSettings, tablesWithoutAccessPolicy, validateSettingsChange} from '../src'

// Default-deny (relaunch Q1): `teeny generate` / `deploy` / `build` refuse a table that has neither a
// rules extension nor `public: true`. The runtime half is in test/worker/defaultDeny.test.ts.

const table = (name: string, extra: Record<string, any> = {}) => ({
    name,
    fields: [{name: 'id', sqlType: 'integer', type: 'integer', primary: true, autoIncrement: true}],
    extensions: [],
    ...extra,
}) as DatabaseSettings['tables'][number]

const settings = (...tables: DatabaseSettings['tables']) => ({tables})

describe('tablesWithoutAccessPolicy', () => {
    it('flags a table with no extensions', () => {
        expect(tablesWithoutAccessPolicy(settings(table('notes')))).toEqual(['notes'])
    })

    it('flags a table whose only extension is auth', () => {
        expect(tablesWithoutAccessPolicy(settings(table('users', {extensions: [{name: 'auth'}]})))).toEqual(['users'])
    })

    it('accepts a rules extension, including an all-null (admin-only) one', () => {
        expect(tablesWithoutAccessPolicy(settings(
            table('a', {extensions: [{name: 'rules', listRule: 'true'}]}),
            table('b', {extensions: [{name: 'rules'}]}),
        ))).toEqual([])
    })

    it('accepts public: true and rejects public: false', () => {
        expect(tablesWithoutAccessPolicy(settings(table('open', {public: true}), table('closed', {public: false}))))
            .toEqual(['closed'])
    })

    it('lists every offending table, in config order', () => {
        expect(tablesWithoutAccessPolicy(settings(
            table('a'), table('b', {extensions: [{name: 'rules'}]}), table('c'),
        ))).toEqual(['a', 'c'])
    })

    it('tolerates a malformed config (zod reports it later)', () => {
        expect(tablesWithoutAccessPolicy({} as any)).toEqual([])
        expect(tablesWithoutAccessPolicy({tables: 'x'} as any)).toEqual([])
        expect(tablesWithoutAccessPolicy({tables: [null, table('t', {extensions: undefined})]} as any)).toEqual(['t'])
    })
})

describe('assertTablesHaveAccessPolicy', () => {
    it('passes when every table declares a policy', () => {
        expect(() => assertTablesHaveAccessPolicy(settings(table('a', {public: true})))).not.toThrow()
        expect(() => assertTablesHaveAccessPolicy(settings())).not.toThrow()
    })

    it('names the table and both ways out', () => {
        let message = ''
        try { assertTablesHaveAccessPolicy(settings(table('notes'))) } catch (e: any) { message = e.message }
        expect(message).toContain('Table "notes" has no access rules.')
        expect(message).toContain("name: 'rules'")
        expect(message).toContain("{name: 'notes', public: true, ...}")
    })

    it('names all offending tables', () => {
        expect(() => assertTablesHaveAccessPolicy(settings(table('a'), table('b'))))
            .toThrow('Tables "a", "b" have no access rules.')
    })
})

describe('public marker survives config validation', () => {
    it('validateSettingsChange keeps public: true', () => {
        const res = validateSettingsChange({jwtSecret: 'x', appUrl: 'http://localhost', tables: [table('open', {public: true})]} as DatabaseSettings, undefined)
        expect(res.config?.tables[0].public).toBe(true)
    })

    it('toggling public is a config change even though the SQL schema is unchanged', () => {
        const last = validateSettingsChange({jwtSecret: 'x', appUrl: 'http://localhost', tables: [table('t', {extensions: [{name: 'rules'}]})]} as DatabaseSettings, undefined).config!
        const next = validateSettingsChange({jwtSecret: 'x', appUrl: 'http://localhost', tables: [table('t', {public: true})]} as DatabaseSettings, last)
        expect(next.config).not.toBeNull()
        expect(next.config?.tables[0].public).toBe(true)
    })
})
