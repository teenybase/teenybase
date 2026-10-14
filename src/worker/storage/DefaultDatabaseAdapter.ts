import type {StorageAdapter, QueryResult} from './StorageAdapter'
import {D1Adapter} from './D1Adapter'
import type {DatabaseConfig} from '../../types/config'

/**
 * Default StorageAdapter. Built-in handling for `d1-binding`; delegates every
 * other `type` to a `StorageAdapter` registered by an extension via
 * `registerDelegate`. Caches the resolved adapter after the first query —
 * late registrations for an already-resolved type are ignored.
 */
export class DefaultDatabaseAdapter implements StorageAdapter {
    private readonly delegates = new Map<string, StorageAdapter>()
    private resolved?: StorageAdapter

    constructor(
        private readonly config: DatabaseConfig | undefined,
        private readonly env: unknown,
    ) {}

    /** Supply the StorageAdapter for a given `type`. Intended to be called from
     *  an `*Extension.init()` when its type matches `settings.database.type`.
     *  Late registrations (after the first query resolves the adapter) are ignored. */
    registerDelegate(type: string, adapter: StorageAdapter): void {
        this.delegates.set(type, adapter)
    }

    async run<T = unknown>(q: string, v: readonly any[]): Promise<QueryResult<T>> {
        return (await this.resolve()).run<T>(q, v)
    }

    async runBatch<T = unknown>(queries: {q: string, v: readonly any[]}[]): Promise<QueryResult<T>[]> {
        return (await this.resolve()).runBatch<T>(queries)
    }

    private async resolve(): Promise<StorageAdapter> {
        if (this.resolved) return this.resolved
        const type = this.config?.type ?? 'd1-binding'

        if (type === 'd1-binding') {
            const bindingName = this.config?.binding ?? 'PRIMARY_DB'
            const binding = (this.env as Record<string, unknown>)[bindingName]
            if (!binding) {
                throw new Error(
                    `DefaultDatabaseAdapter: D1 binding "${bindingName}" not found in env. ` +
                    `Check your wrangler.toml d1_databases block and settings.database.binding.`,
                )
            }
            return this.resolved = new D1Adapter(binding as D1Database)
        }

        // All other types come from registered extensions.
        const d = this.delegates.get(type)
        if (!d) {
            const capitalized = type.split(/[-_]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('')
            throw new Error(
                `DefaultDatabaseAdapter: no adapter registered for database.type="${type}". ` +
                `Import and register the matching extension — e.g. ` +
                `await db.registerExtension(new ${capitalized}Extension(db))`,
            )
        }
        return this.resolved = d
    }
}
