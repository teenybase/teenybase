import {describe, expect, it} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {DatabaseSettings, generateMigrations} from '../src'

// Regression suite for self-referencing column constraints through the add-then-rename path.
//
// `alterTable` adds every new column under a temporary suffixed name (`flag_a1b2c`) and renames it
// into place afterwards, so that a migration which swaps two column names never collides. The
// column DDL is produced by `createFieldQuery`, which substitutes the *head* name only — a `check:`
// is a raw SQL string carried through verbatim. So a column that names itself in its own CHECK used
// to emit
//
//     ALTER TABLE users ADD COLUMN platform_operator_aa5af INTEGER NOT NULL DEFAULT 0
//                                  CHECK(platform_operator IN (0, 1));
//
// SQLite resolves a CHECK expression at ADD COLUMN time, so it can never see `platform_operator`
// and the whole migration aborts with `no such column: platform_operator`. Observed in production
// 2026-08-21; every project that adds a self-checked column hits it.
//
// These tests execute the generated DDL against a real SQLite rather than asserting on strings
// alone, so they fail the same way production did.

/**
 * The `users` table as it stood before the migration that failed: the four columns the application
 * already had, `email` still without its constraint. Deliberately a plain table — the defect is in
 * the DDL layer and has nothing to do with the auth extension, so the fixture does not depend on
 * whether this build can relinquish the framework auth table.
 */
const usersTableBefore = {
    name: 'users',
    fields: [
        {name: 'id', sqlType: 'text', type: 'text', primary: true, noUpdate: true, usage: 'record_uid'},
        {name: 'google_user_id', sqlType: 'text', type: 'text', notNull: true, unique: true},
        {name: 'email', sqlType: 'text', type: 'text', notNull: true, unique: true},
        {name: 'name', sqlType: 'text', type: 'text', notNull: true, unique: true},
    ],
    extensions: [],
}

/**
 * The application's own `users` table, verbatim from the artifact that reproduced this in
 * production — three of its columns carry a CHECK that names a column being added in the same
 * migration (`platform_operator` and `created_at` name themselves, `updated_at` names `created_at`).
 */
const appUsersTable = {
    name: 'users',
    fields: [
        {name: 'id', sqlType: 'text', type: 'text', primary: true, noUpdate: true, usage: 'record_uid'},
        {name: 'google_user_id', sqlType: 'text', type: 'text', notNull: true, unique: true},
        {name: 'email', sqlType: 'text', type: 'text', notNull: true, unique: true, check: 'email = lower(email)'},
        {name: 'name', sqlType: 'text', type: 'text', notNull: true, unique: true},
        {name: 'avatar_url', sqlType: 'text', type: 'text'},
        {
            name: 'platform_operator', sqlType: 'integer', type: 'integer',
            notNull: true, default: {l: 0}, check: 'platform_operator IN (0, 1)',
        },
        {name: 'created_at', sqlType: 'integer', type: 'integer', notNull: true, default: {l: 0}, check: 'created_at >= 0'},
        {
            name: 'updated_at', sqlType: 'integer', type: 'integer',
            notNull: true, default: {l: 0}, check: 'updated_at >= created_at',
        },
    ],
    extensions: [],
}

const postsTable = {
    name: 'posts',
    fields: [
        {name: 'id', sqlType: 'integer', type: 'integer', primary: true, autoIncrement: true},
        {name: 'title', sqlType: 'text', type: 'text'},
    ],
    extensions: [],
}

function settings(tables: any[]): DatabaseSettings {
    return {
        appUrl: 'https://localhost',
        jwtSecret: 'test-secret-1234567890',
        tables,
    } as DatabaseSettings
}

function clone<T>(obj: T): T { return JSON.parse(JSON.stringify(obj)) }

/** Build a database that is in `config`'s shape, by running its own create migrations. */
function databaseFor(config: DatabaseSettings): DatabaseSync {
    const db = new DatabaseSync(':memory:')
    for (const m of generateMigrations(clone(config), undefined).migrations) db.exec(m.sql)
    return db
}

function applyChange(db: DatabaseSync, next: DatabaseSettings, last: DatabaseSettings) {
    const res = generateMigrations(clone(next), clone(last))
    for (const m of res.migrations) db.exec(m.sql)
    return res
}

/** Column names of `table`, as SQLite reports them after the migration ran. */
function columnsOf(db: DatabaseSync, table: string): string[] {
    return db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((r: any) => String(r.name))
}

/**
 * A temp-named ADD COLUMN can never carry a CHECK: the expression is raw user SQL naming the
 * *final* column, which does not exist yet. This is the defect itself, stated as an invariant.
 */
const TEMP_ADD_WITH_CHECK = /ADD COLUMN\s+(\w+?)_[0-9a-f]{5}\b[^;]*CHECK\(/i

describe('self-referencing column constraints through ALTER TABLE', () => {
    it('adds a self-checked column to an existing table (the general case)', () => {
        const before = settings([{
            name: 'widgets',
            fields: [
                {name: 'id', sqlType: 'text', type: 'text', primary: true, noUpdate: true, usage: 'record_uid'},
                {name: 'label', sqlType: 'text', type: 'text'},
            ],
            extensions: [],
        }])
        const after = clone(before)
        after.tables[0].fields.push({
            name: 'flag', sqlType: 'integer', type: 'integer',
            notNull: true, default: {l: 0}, check: 'flag IN (0, 1)',
        } as any)

        const db = databaseFor(before)
        db.exec(`INSERT INTO widgets (id, label) VALUES ('w1', 'first');`)

        const res = applyChange(db, after, before)
        const sql = res.migrations.map(m => m.sql).join('\n')

        expect(sql).toMatch(/ADD COLUMN/i)
        expect(sql).not.toMatch(TEMP_ADD_WITH_CHECK)
        // the column landed under its real name, and the constraint is live
        expect(columnsOf(db, 'widgets')).toContain('flag')
        expect(() => db.exec(`INSERT INTO widgets (id, label, flag) VALUES ('w2', 'second', 7);`)).toThrow(/CHECK/i)
        // the pre-existing row survived
        expect(db.prepare(`SELECT count(*) c FROM widgets`).get()).toMatchObject({c: 1})
    })

    it('adds the four production columns to an existing users table (production repro)', () => {
        const last = settings([clone(usersTableBefore), clone(postsTable)])
        const next = settings([clone(appUsersTable), clone(postsTable)])

        const db = databaseFor(last)
        db.exec(`INSERT INTO users (id, google_user_id, email, name) VALUES ('u0', 'g0', 'a0@x.com', 'n0');`)

        // this threw `no such column: platform_operator: SQLITE_ERROR` in production
        const res = applyChange(db, next, last)

        const sql = res.migrations.map(m => m.sql).join('\n')
        expect(sql).not.toMatch(TEMP_ADD_WITH_CHECK)

        const cols = columnsOf(db, 'users')
        for (const f of appUsersTable.fields) expect(cols).toContain(f.name)
        // no temp-suffixed column survived the migration
        expect(cols.filter(c => /_[0-9a-f]{5}$/.test(c))).toEqual([])
        // the row that was already there came through the rebuild
        expect(db.prepare(`SELECT count(*) c FROM users`).get()).toMatchObject({c: 1})

        // the self-referencing constraints are live on the migrated table
        const insert = (op: number) => db.exec(
            `INSERT INTO users (id, google_user_id, email, name, platform_operator, created_at, updated_at)` +
            ` VALUES ('u${op}', 'g${op}', 'a${op}@x.com', 'n${op}', ${op}, 1, 2);`,
        )
        expect(() => insert(1)).not.toThrow()
        expect(() => insert(9)).toThrow(/CHECK/i)
    })

    it('still rebuilds the table when a self-checked column collides with a renamed one', () => {
        // `a` is renamed to `b` and a NEW `a` (self-checked) takes its place. The new column cannot
        // be added incrementally: `a` is still occupied at ADD COLUMN time, so a temp name is
        // forced, and a temp name cannot carry the CHECK. The table rebuild has to take over.
        const before = settings([{
            name: 'swaps',
            fields: [
                {name: 'id', sqlType: 'text', type: 'text', primary: true, noUpdate: true, usage: 'record_uid'},
                {name: 'a', sqlType: 'text', type: 'text'},
            ],
            extensions: [],
        }])
        const after = settings([{
            name: 'swaps',
            fields: [
                {name: 'id', sqlType: 'text', type: 'text', primary: true, noUpdate: true, usage: 'record_uid'},
                {name: 'b', lastName: 'a', sqlType: 'text', type: 'text'},
                {name: 'a', sqlType: 'integer', type: 'integer', notNull: true, default: {l: 1}, check: 'a > 0'},
            ],
            extensions: [],
        }])

        const db = databaseFor(before)
        db.exec(`INSERT INTO swaps (id, a) VALUES ('s1', 'kept');`)

        const res = applyChange(db, after, before)
        const sql = res.migrations.map(m => m.sql).join('\n')

        expect(sql).not.toMatch(TEMP_ADD_WITH_CHECK)
        expect(sql).toMatch(/CREATE TABLE swaps_/i)   // the rebuild path took over
        expect(columnsOf(db, 'swaps').sort()).toEqual(['a', 'b', 'id'])
        expect(db.prepare(`SELECT b FROM swaps`).get()).toMatchObject({b: 'kept'})
        expect(() => db.exec(`INSERT INTO swaps (id, b, a) VALUES ('s2', 'x', 0);`)).toThrow(/CHECK/i)
    })
})
