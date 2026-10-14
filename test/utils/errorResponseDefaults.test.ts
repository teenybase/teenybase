import {describe, expect, it} from 'vitest'
import {Hono} from 'hono'
import {honoErrorHandler} from '../../src/worker/util/honoErrorHandler'
import {D1Error, FieldError, ProcessError} from '../../src/worker/util/error'

// RESPOND_WITH_ERRORS and RESPOND_WITH_QUERY_LOG are debug flags: off unless explicitly "true"/"1".
// The worker test pool sets both to true, so the default (unset) path is pinned here instead.

const SQL = `INSERT INTO [users] ([email], [password]) VALUES ("a@example.com", '***')`

function failingApp(err: () => Error) {
    const app = new Hono()
    app.get('/', () => { throw err() })
    app.onError(honoErrorHandler as any)
    return app
}

const d1Error = () => {
    const e = new D1Error('Failed to run insert query', 'UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT', new Error('D1'), SQL)
    e.data = {email: {code: 'SQLITE_CONSTRAINT', message: 'A record with this value already exists.', errorMessage: 'UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT'}}
    return e
}

async function call(err: () => Error, env: Record<string, unknown>) {
    const res = await failingApp(err).request('/', {}, env)
    return {status: res.status, body: await res.text()}
}

describe('error responses - debug flags default to off', () => {
    it('unset flags: a D1 error returns only code and message, no SQL and no SQLite message', async () => {
        const {status, body} = await call(d1Error, {})
        expect(status).toBe(400)
        const json = JSON.parse(body)
        expect(json.message).toBe('Failed to run insert query')
        expect(json.data).toEqual({})
        expect(json.queries).toBeUndefined()
        expect(body).not.toContain('INSERT')
        expect(body).not.toContain('SQLITE_CONSTRAINT')
    })

    it('unset flags: a plain Error is masked as "Internal server error"', async () => {
        const {status, body} = await call(() => new Error('db exploded at SELECT * FROM secrets'), {})
        expect(status).toBe(500)
        expect(JSON.parse(body).message).toBe('Internal server error')
        expect(body).not.toContain('secrets')
    })

    it('unset flags: ProcessError input is not echoed', async () => {
        const {body} = await call(() => new ProcessError('Error parsing INSERT data', 400, {values: {email: 'x'}}, new Error('bad')), {})
        const json = JSON.parse(body)
        expect(json.message).toBe('Error parsing INSERT data')
        expect(json.data).toEqual({})
    })

    it('"false" is off, same as unset', async () => {
        const {body} = await call(d1Error, {RESPOND_WITH_ERRORS: 'false', RESPOND_WITH_QUERY_LOG: 'false'})
        expect(JSON.parse(body).data).toEqual({})
    })

    it('RESPOND_WITH_ERRORS=true alone: field errors, but still no rendered SQL', async () => {
        const {body} = await call(d1Error, {RESPOND_WITH_ERRORS: 'true'})
        const json = JSON.parse(body)
        expect(json.data.error).toContain('UNIQUE constraint failed')
        expect(json.data.email.code).toBe('SQLITE_CONSTRAINT')
        expect(json.data.input).toBeUndefined()
        expect(body).not.toContain('INSERT')
    })

    it('a D1Error nested in another error (multi-statement failure) never serializes its SQL', async () => {
        const {body} = await call(() => new ProcessError('D1Errors - Multiple errors when executing sql transaction', 400, {errors: [d1Error(), d1Error()]}), {RESPOND_WITH_ERRORS: 'true'})
        const json = JSON.parse(body)
        expect(json.data.errors).toHaveLength(2)
        expect(json.data.errors[0].error).toContain('UNIQUE constraint failed')
        expect(json.data.errors[0].input).toBeUndefined()
        expect(body).not.toContain('INSERT')
    })

    it.each([{}, {RESPOND_WITH_ERRORS: 'true', RESPOND_WITH_QUERY_LOG: 'true'}])('FieldError returns its field messages with any flags (%o), never its cause', async (env) => {
        const msg = 'An account with this email already exists'
        const {status, body} = await call(() => new FieldError(msg, {email: msg}, d1Error()), env)
        expect(status).toBe(400)
        const json = JSON.parse(body)
        expect(json.message).toBe(msg)
        expect(json.data).toEqual({email: {_errors: [msg]}})
        expect(body).not.toContain('INSERT')
        expect(body).not.toContain('SQLITE_CONSTRAINT')
    })

    it('both flags explicitly true: data.input carries the (redacted) statement', async () => {
        const {body} = await call(d1Error, {RESPOND_WITH_ERRORS: 'true', RESPOND_WITH_QUERY_LOG: '1'})
        expect(JSON.parse(body).data.input).toBe(SQL)
    })
})
