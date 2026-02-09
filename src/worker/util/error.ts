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
    code: string,
    message: string,
    errorMessage: string,
    constraint?: string,
}

export type D1ErrorData = {
    [key: string]: any | D1ColumnError
}

export class D1Error extends Error{
    get data(): D1ErrorData & {input?: string, error: string, cause?: any} {
        return {
            error: this.errorMessage,
            // cause: (this.cause as any)?.message ? (this.cause as any).message : this.cause,
            input: this.input,
            ...this._data,
        }
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
