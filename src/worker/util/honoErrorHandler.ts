import {HTTPResponseError} from "hono/types";
import {Context} from "hono";
import {$Env} from "../env";
import {HTTPException} from "hono/http-exception";
import {ZodError} from "zod";
import {D1Error, ProcessError} from "./error";

export function honoErrorHandler<T extends $Env>(err: Error | HTTPResponseError, c: Context<T>) {
    const $db = c.get('$db')
    const isHTTP = err instanceof HTTPException
    const isD1Error = err instanceof D1Error
    const isZodError = err instanceof ZodError
    const status = isHTTP ? err.status || 500 : (isD1Error || isZodError) ? 400 : 500
    console.error(`Request Error: ${status}`)
    console.error(err, (err as any).status)
    if(isHTTP && err.res) {
        return err.res
    }
    return c.json({
        code: status,
        message: isZodError ? 'Validation Error' : ((isHTTP || !c.env || c.env.RESPOND_WITH_ERRORS || isD1Error) ? (err.message) : 'Internal server error'),
        data: c.env.RESPOND_WITH_ERRORS ? {
            ...(isZodError ? err.format() : null),
            ...(err as ProcessError).data as any
        } : undefined,
        issues: isZodError ? (err as ZodError).issues : undefined,
        queries: c.env.RESPOND_WITH_QUERY_LOG ? $db?.queryLog : undefined,
    }, {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Max-Age': '600',
        }
    })
}
