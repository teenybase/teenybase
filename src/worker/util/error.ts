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

export class D1Error extends Error{
    get data(){
        return {
            error: this.errorMessage,
            // cause: (this.cause as any)?.message ? (this.cause as any).message : this.cause,
            input: this.input,
            ...this._data,
        }
    }
    private _data?: Record<string, any>
    set data(d: Record<string, any>){
        this._data = d
    }
    constructor(public message: string, public errorMessage: string, public cause: any, public input?: string){
        super(message)
    }
}

