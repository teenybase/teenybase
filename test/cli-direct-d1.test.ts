import {describe, expect, it} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {makeD1Binding} from '../src/node/utils/make-d1-binding'
import {$DatabaseNode} from '../src/node/$DatabaseNode'
import {directD1ErrorMessage} from '../src/node/cli-utils'
import {WranglerCommandError} from '../src/node/utils/wrangler-run'
import {createLogger} from '../src/node/logger'

// The CLI's direct D1 path: $DatabaseNode over make-d1-binding.ts, which runs every statement as
// `wrangler d1 execute <binding> --json --command=<sql>`. This fake `runWrangler` executes the
// command on an in-memory SQLite database and prints what wrangler prints: an array with one
// `{results, success, meta}` per statement, or (on a SQL error, --remote) an `{error: {...}}` object
// with exit code 1.
function fakeContext() {
    const sqlite = new DatabaseSync(':memory:')
    const commands: string[] = []
    const c = {
        logger: createLogger('silent'),
        isLocal: false,
        root: process.cwd(),
        localPersistPath: '/nonexistent',
        wranglerConfig: {config: {path: 'wrangler.jsonc'}, db: {binding: 'PRIMARY_DB'}},
        async runWrangler(args: string[]) {
            const sql = args.find(a => a.startsWith('--command='))!.slice('--command='.length)
            commands.push(sql)
            try {
                const results = sqlite.prepare(sql).all()
                return {stdout: JSON.stringify([{results, success: true, meta: {duration: 0}}], null, 2), stderr: '', output: ''}
            } catch (e: any) {
                const stdout = JSON.stringify({error: {
                    text: 'A request to the Cloudflare API (/accounts/x/d1/database/y/query) failed.',
                    notes: [{text: `${e.message}: SQLITE_ERROR [code: 7500]`}],
                    kind: 'error', name: 'APIError', code: 7500,
                }})
                throw new WranglerCommandError('wrangler d1 execute failed (exit code 1)', args, 1, stdout, '', stdout)
            }
        },
    }
    // @ts-expect-error a partial CliContext: only what make-d1-binding.ts reads
    const db = new $DatabaseNode({tables: [], jwtSecret: '', appUrl: ''} as any, makeD1Binding(c))
    return {db, sqlite, commands}
}

describe('direct D1 path (make-d1-binding.ts)', () => {
    it('reads the migrations and the settings with single statements', async () => {
        const {db, sqlite, commands} = fakeContext()
        sqlite.exec(`CREATE TABLE _db_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, sql TEXT NOT NULL, sql_revert TEXT DEFAULT NULL, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`)
        sqlite.exec(`CREATE TABLE _ddb_internal_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expiry INTEGER NULL)`)
        sqlite.exec(`INSERT INTO _db_migrations (name, sql) VALUES ('10000_create_table_users.sql', 'CREATE TABLE users (id TEXT)')`)
        sqlite.prepare(`INSERT INTO _ddb_internal_kv (key, value) VALUES (?, ?), (?, ?), (?, ?)`)
            .run('$settings', JSON.stringify({tables: [{name: 'users'}], version: 3}), '$settings_version', '3', '$settings_1', 'old')

        const list = await db.migrationHelper.list()
        expect(list.map(m => m.name)).toEqual(['10000_create_table_users.sql'])

        // was a 2-statement batch (rawSQLTransaction), which the shim rejects: every redeploy logged
        // "SQL Error" and fell back to the worker API
        const state = await db.migrationHelper.dbSettings()
        expect(state.version).toBe(3)
        expect(state.settings).toEqual({tables: [{name: 'users'}], version: 3})
        expect(commands).toHaveLength(2)
        expect(commands[1]).toContain(`key IN ('$settings', '$settings_version')`)
    })

    it('reads a fresh database as no settings and no version', async () => {
        const {db, sqlite} = fakeContext()
        sqlite.exec(`CREATE TABLE _ddb_internal_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expiry INTEGER NULL)`)
        expect(await db.migrationHelper.dbSettings()).toEqual({settings: undefined, version: null})
    })

    it('reports the SQLite error, not just "SQL Error"', async () => {
        const {db} = fakeContext()
        const err = await db.migrationHelper.list().catch(e => e)
        expect(err.message).toBe('SQL Error')
        expect(directD1ErrorMessage(err)).toContain('no such table: _db_migrations')
    })

    it('rejects batches with a message that says so', async () => {
        const {db, commands} = fakeContext()
        const err = await db.rawSQLTransaction([{q: 'SELECT 1', v: []}, {q: 'SELECT 2', v: []}]).run().catch(e => e)
        expect(directD1ErrorMessage(err)).toContain('Batches (2 statements) are not supported')
        expect(commands).toHaveLength(0)
    })
})
