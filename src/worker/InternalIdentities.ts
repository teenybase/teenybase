import {$DatabaseRaw} from './$DatabaseRawImpl'
import {generateUid} from '../security/random'
import type {DBMigration} from './migrationHelper'

export class InternalIdentities {
    constructor(private db: $DatabaseRaw, readonly tableName = '_auth_identities') {
    }

    // Pure entry-build: setup() calls this and runs the SQL; preview endpoints call
    // it alone. Fixed 00001 prefix — infra slot, below user migrations (≥ 10000).
    previewEntry(version: number): Omit<DBMigration, 'id'> | null {
        if (version < 0) return null
        const sql = `CREATE TABLE IF NOT EXISTS "${this.tableName}" (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, provider_id TEXT, identity_data TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, provider))`
        return {
            name: '00001_create_auth_identities.sql',
            sql,
            sql_revert: `DROP TABLE IF EXISTS "${this.tableName}"`,
        }
    }

    async setup(version: number): Promise<Omit<DBMigration, 'id'> | null> {
        const entry = this.previewEntry(version)
        if (!entry) return null
        await this.db.rawSQL({q: entry.sql, v: []}).run()
        return entry
    }

    async insert(userId: string, provider: string, providerId?: string, identityData?: Record<string, any>) {
        const q = `INSERT OR IGNORE INTO "${this.tableName}" (id, user_id, provider, provider_id, identity_data) VALUES (?, ?, ?, ?, ?)`
        await this.db.rawSQL({q, v: [generateUid(), userId, provider, providerId ?? null, identityData ? JSON.stringify(identityData) : null]}).run()
    }

    async findByUserId(userId: string) {
        const q = `SELECT * FROM "${this.tableName}" WHERE user_id = ?`
        return await this.db.rawSQL<{id: string, user_id: string, provider: string, provider_id: string | null, identity_data: string | null, created_at: string}>({q, v: [userId]}).run() ?? []
    }
}
