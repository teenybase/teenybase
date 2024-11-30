import {AuthContext} from '../types/env'
import {DatabaseSettings} from '../types/config'
import {$Database} from './$Database'

export interface $CloudflareBindings {
    RESPOND_WITH_QUERY_LOG: boolean;
    RESPOND_WITH_ERRORS: true;
    ADMIN_SERVICE_TOKEN?: string;
    ADMIN_JWT_SECRET?: string;
    DATABASE_SETTINGS?: string; // JSON.stringify(DatabaseSettings)
}

export interface $Env {
    Bindings: $CloudflareBindings,
    Variables: {
        auth?: AuthContext
        settings: DatabaseSettings
        $db: $Database
    }
}

export const migrationsTable = '_db_migrations' // this is hardcoded in wrangler, so cannot be changed
