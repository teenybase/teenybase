import {AuthContext} from '../types/env'
import {DatabaseSettings} from '../types/config'
import {$Database} from './$Database'

/** Check if an env var is truthy. Handles both boolean true and string "true"/"1". */
export function envBool(val: unknown): boolean {
    return val === true || val === 'true' || val === '1'
}

export interface $CloudflareBindings {
    /**
     * Debug flag, off unless set to `true` / `"true"` / `"1"`. Adds the executed SQL query log
     * (`queries`) to error responses, and, together with RESPOND_WITH_ERRORS, the rendered SQL
     * statement (`data.input`). Never enable in production.
     */
    RESPOND_WITH_QUERY_LOG?: string | boolean;
    /**
     * Debug flag, off unless set to `true` / `"true"` / `"1"`. Adds error details (`data`, zod
     * `issues`, raw error messages) to error responses. Never enable in production.
     */
    RESPOND_WITH_ERRORS?: string | boolean;
    ADMIN_SERVICE_TOKEN?: string;
    ADMIN_JWT_SECRET?: string;
    DATABASE_SETTINGS?: string; // JSON.stringify(DatabaseSettings)
}

export interface $Env<Bindings = {}, Variables = {}> {
    Bindings: $CloudflareBindings & Bindings,
    Variables: {
        auth?: AuthContext
        settings: DatabaseSettings
        $db: $Database
    } & Variables
}
