import {HTTPResponseError} from "hono/types";
import {Context} from "hono";
import {$Env} from "../env";
import {HTTPException} from "hono/http-exception";
import {z, ZodError} from "zod";
import {D1Error, HTTPError, ProcessError} from "./error";
import {$Database} from '../$Database'

export function ddbErrorHandler<T extends $Env>($db: $Database, err: Error | HTTPResponseError, respondWithErrors: boolean, respondWithQueryLog: boolean) {
    const isHTTP = err instanceof HTTPError || err instanceof HTTPException
    const isD1Error = err instanceof D1Error
    const isZodError = err instanceof ZodError// || (err as ZodError).name === 'ZodError'

    // todo zod 4
    // const isZodError = err instanceof ZodError || err instanceof ZodValidationError
    // const zodErr = err instanceof ZodValidationError ? err.zodError : err as ZodError

    const status = isHTTP ? (err.status || 500) : ((isD1Error || isZodError) ? 400 : 500)
    console.error(`Request Error: ${status}`)
    console.error(err, (err as any).status, `http: ${isHTTP}`)
    // console.error(err.stack)
    return {
        code: status,
        message: isZodError ? 'Validation Error' : ((isHTTP || respondWithErrors || isD1Error) ? (err.message) : 'Internal server error'),
        data: {
            ...(isZodError ? z.formatError(err) : null),
            ...(respondWithErrors ? (err as ProcessError).data as any : {}),
        },
        issues: respondWithErrors && isZodError ? (err as ZodError).issues : undefined,
        queries: respondWithQueryLog ? $db?.queryLog : undefined,
    }
}
export function honoErrorHandler<T extends $Env>(err: Error | HTTPResponseError, c: Context<T>) {
    const isHttp = (err instanceof HTTPError || err instanceof HTTPException)
    if(isHttp && err.res) {
        return err.res
    }
    if ('getResponse' in err && !isHttp) {
        const res = err.getResponse()
        return c.newResponse(res.body, res)
    }

    const res = ddbErrorHandler(c.get('$db'), err, c.env?.RESPOND_WITH_ERRORS, c.env?.RESPOND_WITH_QUERY_LOG)
    return c.json(res, {
        status: res.code,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Max-Age': '600',
        }
    })
}
