import {LinearRouter} from 'hono/router/linear-router'
import {$Table} from './$Table'
import {TableExtensionData} from '../types/table'
import {JsepContext} from '../sql/parse/jsep'
import {InsertQuery} from '../sql/build/insert'
import {DeleteQuery} from '../sql/build/delete'
import {UpdateQuery} from '../sql/build/update'
import {SelectQuery} from '../sql/build/select'
import {parseRequestBody} from './util/parseRequestBody'
import {ProcessError} from './util/error'
import {RouteConfig} from '@hono/zod-openapi'
import {
    ResponseConfig,
    RouteParameter,
    ZodContentObject,
    ZodRequestBody
} from '@asteasolutions/zod-to-openapi/dist/openapi-registry'
import type {ZodType} from 'zod'

export type RouterHandlerFunction = (params: Record<string, string>)=>Promise<Response|undefined>
export type RouteFunction = {raw: RouterHandlerFunction} | ((body: any, params?: Record<string, string>)=>Promise<Record<string, any>|undefined>)

export class TableExtension<TData extends TableExtensionData = TableExtensionData> {
    get name(){
        return this.data.name
    }

    constructor(protected data: TData, protected table: $Table, protected jc: JsepContext) {
    }

    initialize?(): Promise<void>
    async onInsertParse?(query: InsertQuery): Promise<void>
    async onDeleteParse?(query: DeleteQuery, admin?: boolean): Promise<void>
    async onUpdateParse?(query: UpdateQuery): Promise<void>
    async onSelectParse?(query: SelectQuery): Promise<void>
    async onViewParse?(query: SelectQuery, id: string): Promise<void>

    private router: LinearRouter<RouterHandlerFunction> | undefined
    protected _routesInit = false

    // shortcut json routes. read the body and return object as json
    // protected routes: Record<string, (body: any, params?: Record<string, string>)=>Promise<Record<string, any>|undefined>> = {}
    protected routes: {
        handler: RouteFunction,
        path: string,
        method: RouteConfig['method']
        zod: ()=>{
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
    }[] = []

    protected _initRoutes(){
        if(!this.router) this.router = new LinearRouter()
        if(this._routesInit) return this.router
        for (const route of this.routes) {
            this.router.add(route.method.toUpperCase(), route.path, async(params)=>{
                if(typeof route.handler === 'function') {
                    const data = await parseRequestBody(this.jc.c.req)
                    const res = await route.handler(data, params)
                    if (res) return this.jc.c.json(res)
                    throw new ProcessError('Not found', 404)
                }else {
                    return route.handler.raw(params)
                }
            })
        }

        this._routesInit = true
        return this.router
    }

    async route(path: string){
        const router = this._initRoutes()
        const match = router.match(this.jc.c.req.method, '/'+path)
        const [handler, params] = match[0]?.[0] ?? [undefined]
        if(!handler) return undefined
        return await handler(params as Record<string, string>)
    }

    getRoutes(){
        this._initRoutes()
        return this.routes
    }
}
