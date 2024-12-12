import {HTTPException} from 'hono/http-exception'
import {Context} from 'hono'

// MultipartJsonKey is the key for the special multipart/form-data
// handling allowing reading serialized json payload without normalization.
const MultipartJsonKey: string = "@jsonPayload"
export async function parseRequestBody<T = any>(req: Context['req']) {
    if (req.method === 'GET') return req.query() as T
    const cType = req.header('Content-Type')?.split(';')[0]
    // console.log(cType)

    if (cType === undefined) {
        throw new HTTPException(400, {message: 'Content-Type header required'})
        return null
    }
    if (cType === 'application/json') {
        const body = await req.text()
        if(!body) return null
        try {
            return JSON.parse(body) as T
        }catch (e){
            throw new HTTPException(400, {message: 'Invalid JSON body'})
        }
    }
    if (cType === 'multipart/form-data' || cType === 'application/x-www-form-urlencoded') {
        const body = await req.parseBody({all: true, dot: true})
        if (body[MultipartJsonKey]) {
            let json = body[MultipartJsonKey] as string | string[]
            delete body[MultipartJsonKey]
            if(!Array.isArray(json)) json = [json]
            for (const str of json) {
                deepMergeFormData(body, JSON.parse(str))
            }
        }
        return body as T
    }
    return null
}

function deepMergeFormData(formData: Record<string, any>, json: Record<string, any>){
    for (const key in json) {
        const val = json[key]
        const isObject = typeof val === 'object' && val !== null
        const isArray = Array.isArray(val)
        if (isObject || isArray) {
            if (formData[key] === undefined) {
                formData[key] = val
            } else if(isArray){
                formData[key].push(...val)
            }else{
                deepMergeFormData(formData[key], val)
            }
        } else {
            formData[key] = val
        }
    }
}
