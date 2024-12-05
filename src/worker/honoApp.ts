import {Context, Hono} from 'hono'
import {cors} from 'hono/cors'
import {honoErrorHandler} from './util/honoErrorHandler'
import {$Env} from './env'
import {$Database} from './$Database'
import {logger} from 'hono/logger'

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
        c.set('$db', createDb(c))
        return next()
    })
    app.use('/api/*', async (c: Context<$Env>, next) => {
        return (await c.get('$db').route(c.req.path)) ?? await next()
    })

    // todo mailgun webhook


    return app
}
