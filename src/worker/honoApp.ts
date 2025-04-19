import {Context, Hono} from 'hono'
import {cors} from 'hono/cors'
import {honoErrorHandler} from './util/honoErrorHandler'
import {$Env} from './env'
import {$Database} from './$Database'
import {logger} from 'hono/logger'

export function teenyHono<T extends $Env=$Env>(
    createDb: (c: Context<T>)=>Promise<$Database<T>>,
    app?: Hono<T>,
    options: {logger: boolean, cors: boolean} = {logger: true, cors: true},
    onRequest?: (c: Context<T>)=>Promise<Response|undefined>,
    beforeRoute?: (c: Context<T>)=>Promise<Response|undefined>
){
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
        c.set('$db', await createDb(c))
        if(onRequest) {
            const res = await onRequest(c)
            if(res) return res
        }
        return next()
    })
    app.use('/api/*', async (c, next) => {
        if(beforeRoute) {
            const res = await beforeRoute(c)
            if(res) return res
        }
        const base = c.req.routePath.replace('/api/*', '')
        const path = c.req.path.replace(base, '')
        let res = (await c.get('$db').route(path))
        if(!res) res = await next()
        return res
    })

    return app
}
