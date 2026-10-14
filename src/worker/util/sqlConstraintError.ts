// Matching SQL constraint violations from what the storage layer actually throws.
//
// Kept out of $Table.parseD1Error's structured output on purpose. That output is derived from the
// same message string, is only produced when the run context carried a table
// ($DatabaseRawImpl.ts - `prep.c?.table?.parseD1Error(e)`), and is wrong on the non-binding
// adapters, which prefix their own class name onto the message and discard the structured result
// code their backend sends (issues/open/storage-adapter-error-normalization.md). Matching the
// message text is the only signal available on every path.

/** `$&` is the whole match. Local copy: src/node/utils.ts is CLI-only and must not enter the worker bundle. */
function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Non-global on purpose - a /g regex carries lastIndex state between calls. */
const UNIQUE_CONSTRAINT_RE = /unique constraint failed/i

/**
 * Best-effort SQL-level text for anything thrown by the storage layer.
 *
 * Order matters:
 *  - `data.error`   - the full SQLite text once $Table.parseD1Error has run.
 *  - `errorMessage` - the same text on a D1Error where parseD1Error did not run.
 *  - `message`      - plain adapter errors ("D1HttpAdapter: ..."). On a D1Error this is only the
 *                     label ('Failed to run insert query'), which is why it comes last.
 *
 * Deliberately ignores the rest of D1Error.data: `data.input` holds the rendered statement, and
 * matching a column name against the statement text would always succeed.
 */
export function sqlErrorText(error: any): string {
    if (typeof error === 'string') return error
    if (!error || typeof error !== 'object') return ''
    const t = error.data?.error ?? error.errorMessage ?? error.message
    return typeof t === 'string' ? t : ''
}

/**
 * True when `error` reports a UNIQUE violation on `column`.
 *
 * The column is anchored on `.<column>` with a word-boundary lookahead, so `username` does not
 * match `users.username_lower` and `email` does not match `users.email_verified`. The column name
 * is regex-escaped. Walks the `cause` chain (bounded) so the check survives later wrapping.
 */
export function isUniqueViolationOn(error: any, column: string | undefined | null): boolean {
    if (!column) return false
    const colRe = new RegExp(`\\.${escapeRegExp(column)}(?![A-Za-z0-9_])`)
    for (let e: any = error, depth = 0; e && depth < 4; e = e.cause, depth++) {
        const text = sqlErrorText(e)
        if (text && UNIQUE_CONSTRAINT_RE.test(text) && colRe.test(text)) return true
    }
    return false
}
