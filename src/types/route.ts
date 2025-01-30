import {RouteConfig} from '@hono/zod-openapi'
import type {
    ResponseConfig,
    RouteParameter,
    ZodContentObject,
    ZodRequestBody
} from '@asteasolutions/zod-to-openapi/dist/openapi-registry'
import type {ZodType} from 'zod'

export type RawRouterHandlerFunction = (params: Record<string, string>, path: string)=>Promise<Response|undefined>
export type RouterHandlerFunction = ((body: any, params: Record<string, string>, path: string)=>Promise<Record<string, any>|undefined>)
export type RouteFunction = {raw: RawRouterHandlerFunction} | RouterHandlerFunction

// todo better name
export type HttpRoute = {
    handler: RouteFunction,
    path: string,
    method: RouteConfig['method']
    zod: ()=>HttpRouteZod
}

export type HttpRouteZod = {
    description: string
    request: {
        body?: ZodRequestBody;
        params?: RouteParameter;
        query?: RouteParameter;
        cookies?: RouteParameter;
        headers?: RouteParameter | ZodType<unknown>[];
    }
    responses: {
        [statusCode: string]: {
            description: string;
            headers?: ResponseConfig['headers'];
            links?: ResponseConfig['links'];
            content?: ZodContentObject;
        }}
}
