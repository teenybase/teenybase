import {HTTPException} from 'hono/http-exception'
import {Context} from 'hono'

// MultipartJsonKey is the key for the special multipart/form-data
// handling allowing reading serialized json payload without normalization.
const MultipartJsonKey: string = "@jsonPayload"
export async function parseRequestBody(req: Context['req']) {
    if (req.method === 'GET') return req.query()
    const cType = req.header('Content-Type')?.split(';')[0]
    // console.log(cType)

    if(cType === undefined) throw new HTTPException(400, {message: 'Content-Type header required'})
    if (cType === 'application/json') {
        const body = await req.text()
        if(!body) return {}
        try {
            return JSON.parse(body)
        }catch (e){
            throw new HTTPException(400, {message: 'Invalid JSON body'})
        }
    }
    if (cType === 'multipart/form-data' || cType === 'application/x-www-form-urlencoded') {
        const body = await req.parseBody({all: true, dot: true})
        if (body[MultipartJsonKey]) {
            const json = body[MultipartJsonKey] as string
            delete body[MultipartJsonKey]
            Object.assign(body, JSON.parse(json))
        }
        return body
    }
    return null
}
