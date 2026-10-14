import {HTTPException} from 'hono/http-exception'
import {Context, HonoRequest} from 'hono'
// @ts-ignore
import type {BodyData, ParseBodyOptions} from 'hono/dist/types/utils/body'

// MultipartJsonKey is the key for the special multipart/form-data
// handling allowing reading serialized json payload without normalization.
const MultipartJsonKey: string = "@jsonPayload"
const MultipartFilesKey: string = "@filePayload"
export async function parseRequestBody<T = Record<string, any>>(req: Context['req']) {
    return ((req.bodyCache as any).parsedBody ??= await _parseRequestBody(req)) ?? null
}
export async function _parseRequestBody<T = Record<string, any>>(req: Context['req']) {
    if (req.method === 'GET') return req.query() as T
    const cType = req.header('Content-Type')?.split(';')[0]
    // console.log(cType)

    if (cType === undefined) {
        throw new HTTPException(400, {message: 'Content-Type header required'})
        return undefined
    }
    if (cType === 'application/json') {
        const body = await req.text()
        if(!body) return undefined
        return parseJson(body) as T
    }
    if (cType === 'multipart/form-data' || cType === 'application/x-www-form-urlencoded') {
        const body = await parseFormData(req, {all: true, dot: true})
        if (body[MultipartJsonKey]) {
            let json = body[MultipartJsonKey] as string | string[]
            delete body[MultipartJsonKey]
            let files = body[MultipartFilesKey] as (File|string) | (File|string)[] | undefined
            delete body[MultipartFilesKey]
            if(!Array.isArray(json)) json = [json]
            if (files &&
                (typeof files === 'string' || (files as File).size !== undefined) &&
                !Array.isArray(files)
            ) files = [files]
            for (const str of json) {
                // todo `str` could be a File instead of a string
                deepMergeFormData(body, parseJson(str))
            }
            if(files) {
                // @ts-expect-error it could be both array or object depending on how its sent. in js it doesnt matter if we access it as number or string
                replaceFileReferences(body, files)
            }
        }
        return body as T
    }
    return undefined
}

function parseJson(body: string): Record<string, any> {
    try {
        return JSON.parse(body)
    } catch (e) {
        throw new HTTPException(400, {message: 'Invalid JSON body'})
    }
}

function deepMergeFormData(formData: Record<string, any>, json: Record<string, any>) {
    for (const key in json) {
        const val = json[key]
        const isObject = typeof val === 'object' && val !== null
        const isArray = Array.isArray(val)
        if (isObject || isArray) {
            if (formData[key] === undefined) {
                formData[key] = val
            } else if(isArray){
                if(!Array.isArray(formData[key])) {
                    formData[key] = [formData[key]] // convert to array if not already
                }
                formData[key].push(...val)
            }else{
                deepMergeFormData(formData[key], val)
            }
        } else {
            formData[key] = val
        }
    }
}

function replaceFileReferences(data: Record<string, any> | any[], files?: Record<string|number, (File | string)>) {
    for (const key1 in data) {
        // @ts-ignore
        const val = data[key1]
        if(typeof val === 'object') { // object or array
            replaceFileReferences(val, files)
            continue
        }
        if(files && typeof val === 'string' && val.startsWith(MultipartFilesKey)){
            let key = val.slice(MultipartFilesKey.length)
            if(!key.length) key = '.0' // first
            if(key[0] === '.') {
                key = key.slice(1) // remove leading dot
                const file = files[key]
                if (file) {
                    // @ts-ignore
                    data[key1] = file
                    continue
                }
            }
        }
    }
}

// below section copied from hono https://github.com/honojs/hono/blob/530ab09ae10caf33903dfb677dff239df01d5ded/src/utils/body.ts#L114

type FormDataEntryValue  = string | File
type BodyDataValue = any;

/**
 * Parses form data from a request.
 *
 * @template T - The type of the parsed body data.
 * @param {HonoRequest | Request} request - The request object containing form data.
 * @param {ParseBodyOptions} options - Options for parsing the form data.
 * @returns {Promise<T>} The parsed body data.
 */
async function parseFormData<T extends BodyData>(
    request: HonoRequest | Request,
    options: ParseBodyOptions
): Promise<T> {
    const formData = await (request as Request).formData()

    if (formData) {
        return convertFormDataToBodyData<T>(formData, options)
    }

    return {} as T
}

/**
 * Converts form data to body data based on the provided options.
 *
 * @template T - The type of the parsed body data.
 * @param {FormData} formData - The form data to convert.
 * @param {ParseBodyOptions} options - Options for parsing the form data.
 * @returns {T} The converted body data.
 */
function convertFormDataToBodyData<T extends BodyData = BodyData>(
    formData: FormData,
    options: ParseBodyOptions
): T {
    const form: BodyData = Object.create(null)

    formData.forEach((value, key) => {
        const shouldParseAllValues = options.all || key.endsWith('[]')

        if (!shouldParseAllValues) {
            form[key] = value
        } else {
            handleParsingAllValues(form, key, value)
        }
    })

    if (options.dot) {
        Object.entries(form).forEach(([key, value]) => {
            const shouldParseDotValues = key.includes('.')

            if (shouldParseDotValues) {
                handleParsingNestedValues(form, key, value)
                delete form[key]
            }
        })
    }

    return form as T
}

/**
 * Handles parsing all values for a given key, supporting multiple values as arrays.
 *
 * @param {BodyData} form - The form data object.
 * @param {string} key - The key to parse.
 * @param {FormDataEntryValue} value - The value to assign.
 */
const handleParsingAllValues = (
    form: BodyData<{ all: true }>,
    key: string,
    value: FormDataEntryValue
): void => {
    if (form[key] !== undefined) {
        if (Array.isArray(form[key])) {
            ;(form[key] as (string | File)[]).push(value)
        } else {
            form[key] = [form[key] as string | File, value]
        }
    } else {
        if (!key.endsWith('[]')) {
            form[key] = value
        } else {
            form[key] = [value]
        }
    }
}

/**
 * Handles parsing nested values using dot notation keys.
 *
 * @param {BodyData} form - The form data object.
 * @param {string} key - The dot notation key.
 * @param {BodyDataValue} value - The value to assign.
 */
const handleParsingNestedValues = (
    form: BodyData,
    key: string,
    value: BodyDataValue//<Partial<ParseBodyOptions>>
): void => {
    let nestedForm = form
    const keys = key.split('.')

    keys.forEach((key, index) => {
        if (index === keys.length - 1) {
            nestedForm[key] = value
        } else {
            if (
                !nestedForm[key] ||
                typeof nestedForm[key] !== 'object' ||
                Array.isArray(nestedForm[key]) ||
                nestedForm[key] instanceof File
            ) {
                nestedForm[key] = Object.create(null)
            }
            nestedForm = nestedForm[key] as unknown as BodyData
        }
    })
}
