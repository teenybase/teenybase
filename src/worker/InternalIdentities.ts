import {$Database} from './$Database'
import {$Env} from './env'
import {generateUid} from '../security/random'

export class InternalIdentities<T extends $Env = $Env> {
    constructor(private db: $Database<T>, readonly tableName = '_auth_identities') {
    }

    async setup(version: number) {
        if (version >= 0) {
            const sql = `
            CREATE TABLE IF NOT EXISTS "${this.tableName}" (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                provider_id TEXT,
                identity_data TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, provider)
            )`.split('\n').map(l => l.trim()).join(' ')
            await this.db.rawSQL({q: sql, v: []}).run()
        }
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
