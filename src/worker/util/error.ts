import {HTTPException} from 'hono/http-exception'
// @ts-ignore
import type {StatusCode} from 'hono/dist/types/utils/http-status'

/**
 * parse error with message, input data, and embedded error
 */
export class ProcessError extends HTTPException{
    get data(){
        return {
            error: (this.cause as any)?.message ? (this.cause as any).message : this.cause,
            ...this.input
        }
    }
    constructor(public message: string, code: StatusCode = 400, public input?: Record<string, any>, cause?: any){
        super(code, {message, cause})
    }
}

export type D1ColumnError = {
    /**
     * Primary SQLite result code, e.g. `SQLITE_CONSTRAINT`. Optional: a backend that does not
     * report one (the d1-http / d1-rest / libsql adapters drop it today) leaves this undefined
     * rather than getting some other message fragment mistaken for a code.
     */
    code?: string,
    /**
     * Named extended result code, e.g. `SQLITE_CONSTRAINT_UNIQUE`. Present only when the backend
     * reports one — workerd appends it to the message from 2026-03-19 (commit fa433142). Strictly
     * more specific than `code`; prefer it when branching on the kind of constraint that failed.
     */
    extendedCode?: string,
    message: string,
    errorMessage: string,
    constraint?: string,
}

export type D1ErrorData = {
    [key: string]: any | D1ColumnError
}

export class D1Error extends Error{
    /**
     * Client-safe error data: the SQLite message plus the per-column detail a frontend needs to
     * show field errors. Deliberately EXCLUDES `input` - the rendered statement is debug output,
     * see debugData.
     */
    get data(): D1ErrorData & {error: string, cause?: any} {
        return {
            error: this.errorMessage,
            // cause: (this.cause as any)?.message ? (this.cause as any).message : this.cause,
            ...this._data,
        }
    }
    /** data + the rendered statement. Gated on RESPOND_WITH_QUERY_LOG, same as the query log. */
    get debugData(): D1ErrorData & {input?: string, error: string} {
        return {...this.data, input: this.input}
    }
    /**
     * A D1Error can end up inside another error's data (e.g. the `errors` array of a failed
     * transaction) and be serialized by c.json() from there. Serialize only the client-safe shape so
     * the rendered statement (`input`) and the raw driver error (`cause`) never leak that way.
     */
    toJSON(){
        return {message: this.message, ...this.data}
    }
    private _data?: D1ErrorData
    set data(d: D1ErrorData){
        this._data = d
    }
    constructor(public message: string, public errorMessage: string, public cause: any, public input?: string){
        super(message)
    }
}

export class HTTPError extends HTTPException{
    readonly isHTTPException = true
}

/**
 * A client error about specific input fields. The field messages are written for the end user, so
 * the error handler always returns them, even with RESPOND_WITH_ERRORS off, in the same
 * `data: {<field>: {_errors: [...]}}` shape as a validation error. Never put SQL or internal details in it;
 * pass the underlying error as `cause` instead (it is logged server-side, never sent).
 */
export class FieldError extends HTTPException{
    constructor(message: string, public fields: Record<string, string>, cause?: unknown, code: StatusCode = 400){
        super(code, {message, cause})
    }
    get fieldErrors(): Record<string, {_errors: string[]}> {
        return Object.fromEntries(Object.entries(this.fields).map(([k, v]) => [k, {_errors: [v]}]))
    }
}

// ── SQLite / D1 error message parsing ───────────────────────────────────────────
// Lives here rather than in $Table so it is a pure function: unit-testable under the plain node
// vitest project, with no workers pool and therefore no dependence on which workerd the pool pins.

/** Human text per constraint kind, keyed by the leading segment of the SQLite message. */
const d1ErrorMap: Record<string, string> = {
    'UNIQUE constraint failed': 'A record with this value already exists.',
    'NOT NULL constraint failed': 'This field cannot be NULL.',
    // 'FOREIGN KEY constraint failed': 'Unable to find related record (Foreign Key).',
    'FOREIGN KEY constraint failed': 'Foreign Key constraint failed.', // todo add test for this
}

// workerd's dbErrorMessage() (src/workerd/util/sqlite.c++) builds the message as:
//   <errmsg> [" at offset N"] ": " <CODE> [" (extended: " <EXTENDED_CODE> ")"]
// The extended suffix arrived in commit fa433142 (2026-03-19) and is why a naive
// split(':').pop() yields "SQLITE_CONSTRAINT_UNIQUE)" — closing paren included.
const D1_EXTENDED_RE = /\s\(extended:\s([A-Za-z0-9_]+)\)\s*$/
// sqlite3_error_offset() appends to the END of the raw errmsg, i.e. onto the `table.column`
// segment — not onto the leading segment. Left in place it defeats column detection entirely.
const D1_OFFSET_RE = /\s+at offset \d+$/
// Guards the trailing-code pop: a message with no result code (the storage adapters prefix their
// own class name and drop the code) must not have `users.email` mistaken for one.
const D1_CODE_RE = /^SQLITE_[A-Z0-9_]+$/

export interface ParsedD1Message {
    /** Every recognised column named in the message, in order of appearance. */
    columns: string[]
    code?: string
    extendedCode?: string
    constraint?: string
    /** Mapped human text, when the leading segment is a known constraint kind. */
    mapped?: string
    /** Leading segment, offset suffix removed. */
    head: string
}

/**
 * Parse a SQLite/D1 error message into its parts.
 *
 * Shapes this must survive (all real):
 *   NOT NULL constraint failed: files.config: SQLITE_CONSTRAINT
 *   FOREIGN KEY constraint failed: SQLITE_CONSTRAINT
 *   UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)
 *   NOT NULL constraint failed: files.config at offset 12: SQLITE_CONSTRAINT
 *   UNIQUE constraint failed: users.a, users.b: SQLITE_CONSTRAINT      (composite index)
 *   D1HttpAdapter: UNIQUE constraint failed: users.email                (adapter-prefixed, no code)
 *
 * @param msg     the verbatim message (D1Error.errorMessage)
 * @param isField predicate identifying a column of the table the statement ran against
 */
export function parseD1ErrorMessage(msg: string, isField: (name: string) => boolean): ParsedD1Message {
    if (typeof msg !== 'string' || !msg) return {columns: [], head: ''}
    const ext = D1_EXTENDED_RE.exec(msg)
    const base = ext ? msg.slice(0, ext.index) : msg
    const parts = base.split(':').map(p => p.trim().replace(D1_OFFSET_RE, ''))
    let code = D1_CODE_RE.test(parts[parts.length - 1]) ? parts.pop() : undefined
    let extendedCode = ext ? ext[1] : undefined
    // A tail that is itself an EXTENDED code, with no wrapper and no primary code:
    //   NOT NULL constraint failed: users.name: SQLITE_CONSTRAINT_NOTNULL
    // Every SQLite PRIMARY code is SQLITE_<one token> (SQLITE_CONSTRAINT, SQLITE_IOERR, ...), so a
    // name with more tokens than that is unambiguously extended. Decompose it rather than leaving an
    // extended code sitting in the primary field, where a consumer comparing against
    // SQLITE_CONSTRAINT would still miss. Defensive: no runtime observed emitting this shape.
    if (code) {
        const seg = code.split('_')
        if (seg.length > 2) {
            if (!extendedCode) extendedCode = code
            code = seg.slice(0, 2).join('_')
        }
    }
    const columns: string[] = []
    for (const part of parts) {
        // A composite index names several columns in one segment: `users.a, users.b`
        for (const seg of part.split(',')) {
            const c = seg.trim().split('.').pop()
            if (c && isField(c) && !columns.includes(c)) columns.push(c)
        }
    }
    const head = parts[0] ?? ''
    const ci = head.indexOf('constraint failed')
    return {
        columns,
        code,
        extendedCode,
        constraint: ci > 0 ? head.substring(0, ci - 1) : undefined,
        mapped: d1ErrorMap[head],
        head,
    }
}
