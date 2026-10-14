import {DatabaseSettings} from '../config'

/**
 * Names of tables that declare no access policy: no `rules` extension and no `public: true`.
 *
 * At runtime such a table is default-deny (only admin and service-token requests get through, see
 * $Table). That is safe but almost never what the author meant, so the CLI refuses to generate or
 * deploy until every table says explicitly what it wants.
 */
export function tablesWithoutAccessPolicy(settings: Pick<DatabaseSettings, 'tables'>): string[] {
    const tables = Array.isArray(settings?.tables) ? settings.tables : []
    return tables
        .filter(t => t && typeof t === 'object')
        .filter(t => t.public !== true && !(Array.isArray(t.extensions) && t.extensions.some(e => e?.name === 'rules')))
        .map(t => String(t.name))
}

/**
 * Throws an Error naming every table without an access policy and the two ways to fix it.
 * Used by `teeny generate`, `teeny deploy` and `teeny build`.
 */
export function assertTablesHaveAccessPolicy(settings: Pick<DatabaseSettings, 'tables'>): void {
    const names = tablesWithoutAccessPolicy(settings)
    if (!names.length) return
    const list = names.map(n => `"${n}"`).join(', ')
    const example = names[0]
    throw new Error([
        `${names.length === 1 ? 'Table' : 'Tables'} ${list} ${names.length === 1 ? 'has' : 'have'} no access rules.`,
        `A table without a rules extension rejects every list/view/insert/update/delete request except admin and service-token ones, so its API would not work for your users.`,
        `Fix each table in one of two ways:`,
        `  1. Add a rules extension that says who can do what, e.g. public read with admin-only writes:`,
        `       extensions: [{name: 'rules', listRule: 'true', viewRule: 'true'}]`,
        `     Omitted rules stay null = denied; add createRule/updateRule/deleteRule expressions such as 'auth.uid == owner_id'.`,
        `     Use {name: 'rules'} alone for an admin-only table.`,
        `  2. Mark it public, which lets anyone, including unauthenticated requests, list, view, insert, update and delete rows:`,
        `       {name: '${example}', public: true, ...}`,
        `See "Access Control Defaults" in docs/config-reference.md.`,
    ].join('\n'))
}
