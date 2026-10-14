import {OpenApiGeneratorV31, OpenAPIRegistry} from '@asteasolutions/zod-to-openapi'
import {z} from 'zod'
import {swaggerUI} from '@hono/swagger-ui'
import {Context} from 'hono'
import {$Database} from '../$Database'
import {HttpRoute, HttpRouteZod} from '../../types/route'
import {$DBExtension} from '../$DBExtension'
import {extendZodWithOpenApi, RouteConfig} from '@hono/zod-openapi'
import {$Env} from '../env'

// Extend zod at module level so all schemas (including those created at import time
// in other modules) get the .openapi() method before any route registration happens.
// todo move it somewhere else?
extendZodWithOpenApi(z);

export class OpenApiExtension<T extends $Env = $Env> implements $DBExtension<T>{
    routes: HttpRoute[] = []

    constructor(private readonly db: $Database<T>, swagger  = true) {
        this.routes.push({
            path: '/doc',
            method: 'get',
            handler: {raw: async()=>{
                    return db.c.json(this.getDoc())
                }},
            zod: ()=>(<HttpRouteZod>{
                description: 'OpenAPI documentation',
                request: {},
                responses: {
                    '200': {
                        description: 'Success',
                        content: {'application/json': {
                                schema: z.record(z.string(), z.unknown()),
                            }},
                    }
                },
            })
        })
        if(swagger){
            this.routes.push({
                path: '/doc/ui',
                method: 'get',
                handler: {raw: async()=>{
                        const res = await swaggerUI({ url: this.db.apiBase + '/doc' })(db.c as Context, async ()=>{return})
                        return res ? res : undefined
                    }},
                zod: ()=>(<HttpRouteZod>{
                    description: 'Swagger UI',
                    request: {},
                    responses: {
                        '200': {
                            description: 'Success',
                            content: {'text/html': {
                                    schema: z.string(),
                                }},
                        }
                    },
                })
            })
        }
    }

    getDoc(){
        const allRoutes: RouteConfig[] = []
        allRoutes.push(...this.getApiRoutes(this.db.getRoutes(), this.db.apiBase))
        this.db.allTables().forEach((table) => allRoutes.push(...this.getApiRoutes(table.getRoutes(), this.db.apiTableBase+'/'+table.name)))

        // Register routes individually, skipping any that fail registration or doc generation.
        // Some zod schemas (e.g. superRefine, custom validators) are incompatible with zod-to-openapi.
        const registry = new OpenAPIRegistry();
        for (const route of allRoutes) {
            try {
                // Test that this route can be registered AND generated without error
                const testReg = new OpenAPIRegistry()
                testReg.registerPath(route)
                new OpenApiGeneratorV31(testReg.definitions).generateDocument({openapi: '3.1.0', info: {version: '1.0.0', title: 'tmp'}})
                // If it passes, register it for real
                registry.registerPath(route)
            } catch (e: any) {
                console.warn(`OpenAPI: Skipping route ${route.method?.toUpperCase()} ${route.path}: ${e.message}`)
            }
        }

        const generator = new OpenApiGeneratorV31(registry.definitions);
        return generator.generateDocument({
            openapi: '3.1.0',
            info: {
                version: '1.0.0',
                title: 'Teenybase API',
            },
        });
    }

    private getApiRoutes(routes: HttpRoute[], prefix = ''): RouteConfig[]{
        let apiRoutes = [] as RouteConfig[]
        for (const route of routes) {
            const zod = route.zod()
            if(!zod.request.headers) zod.request.headers = z.object({authorization: z.string().min(1).max(255).optional()})
            apiRoutes.push({
                path: prefix + route.path,
                method: route.method.toLowerCase() as any,
                ...zod,
            })
        }
        return apiRoutes
    }

}
