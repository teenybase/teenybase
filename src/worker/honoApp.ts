import {Context, Hono} from 'hono'
import {HTTPException} from 'hono/http-exception'
import {cors} from 'hono/cors'
import {honoErrorHandler} from './util/honoErrorHandler'
import {$Env, migrationsTable} from './env'
import {$Database} from './$Database'
import {logger} from 'hono/logger'
import {z} from 'zod'
import {OpenApiGeneratorV31, OpenAPIRegistry} from '@asteasolutions/zod-to-openapi'
import {swaggerUI} from '@hono/swagger-ui'
import {setupMigrationRoutes} from './migrationHelper'

export function teenyHono<T extends $Env=$Env>(createDb: (c: Context<T>)=>$Database<T>, app?: Hono<T>, options: {logger: boolean, cors: boolean} = {logger: true, cors: true}){
    app = app ?? new Hono<T>()

    app.onError(honoErrorHandler)

    options.logger && app.use(logger())
    options.cors && app.use('*', async (c, next) => {
        const corsMiddlewareHandler = cors({
            origin: '*',
            allowHeaders: ['*'],
            allowMethods: ['POST', 'GET', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'],
            exposeHeaders: ['*'],
            maxAge: 600,
            credentials: true,
        })
        return corsMiddlewareHandler(c, next)
    })

    // $db init
    app.use('*', async (c, next) => {
        const $db = createDb(c)
        c.set('$db', $db)
        return next()
    })
    app.use('/api/*', async (c, next) => {
        await c.get('$db').initAuth() // load from bearer auth header
        return next()
    })

    // todo mailgun webhook

    app.post('/api/v1/setup-db', async (c: Context<$Env>) => {
        if(!c.get('auth')?.admin) throw new HTTPException(403, {message: 'Forbidden'})
        const $db = c.get('$db')
        await $db.setup()
        // todo check schema and settings and do other verifications like secrets are set etc.
        return c.json($db.settings)
    })

    setupMigrationRoutes(app, '/api/v1')

    app.get('/api/v1/files/:table/:rid/:path{.+}', async (c: Context<$Env>) => {
        const meta = c.get('$db').table(c.req.param('table'))
        const token = c.req.query('token');
        // todo proper auth using presigned urls or auth token.
        const db = c.get('settings')
        const path = z.string().min(1).max(255).regex(/^[a-zA-Z0-9_\-\/.\*\+\=\#]+$/).parse(c.req.param('path'))
        const rid = z.string().min(1).max(255).parse(c.req.param('rid'))
        const object = await meta.getFile(path, rid)
        return object
    })

    app.all('/api/raw/v1/:table/*', async (c: Context<$Env>) => {
        const id = c.req.param('table')
        const table = c.get('$db').table(id)

        const base = c.req.routePath.replace(':table/*', id+'/')
        const path = c.req.path.replace(base, '')
        const res = await table.route(path)
        if(!res) throw new HTTPException(404, {message: 'Not found'})
        return res
    })

    app.get('/doc/ui', swaggerUI({ url: '/doc' }))
    app.get('/doc', async (c: Context<$Env>) => {
        const $db = c.get('$db')
        const registry = new OpenAPIRegistry();
        $db.allTables().forEach((table) => table.getApiRoutes().forEach((route) => registry.registerPath(route)))
        const generator = new OpenApiGeneratorV31(registry.definitions);
        const doc = generator.generateDocument({
            openapi: '3.1.0',
            info: {
                version: '1.0.0',
                title: 'Teenybase API',
                // description: '',
                // contact: {},
                // license: {},
                // termsOfService: '',
            },
        });
        return c.json(doc)
    })

    return app
}
