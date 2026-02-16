import {Context, Hono} from 'hono'
import {cors} from 'hono/cors'
import {honoErrorHandler} from './util/honoErrorHandler'
import {$Env} from './env'
import {$Database} from './$Database'
import {logger} from 'hono/logger'

type CORSOptions = Parameters<typeof cors>[0]
type PrintFunc = Parameters<typeof logger>[0]

export function teenyHono<T extends $Env=$Env>(
    createDb: (c: Context<T>)=>Promise<$Database<T>>,
    app?: Hono<T>,
    options: {
        logger?: boolean|PrintFunc,
        cors?: boolean|CORSOptions,
        onError?: boolean|typeof honoErrorHandler,
    } = {logger: true, cors: true},
    onRequest?: (c: Context<T>)=>Promise<Response|undefined>,
    beforeRoute?: (c: Context<T>)=>Promise<Response|undefined>
){
    app = app ?? new Hono<T>()

    options.onError !== false && app.onError(typeof options.onError === 'function' ? options.onError : (err, c) => {
        return honoErrorHandler(err, c)
    })

    !!options.logger && app.use(logger(typeof options.logger === 'boolean' ? undefined : options.logger))
    !!options.cors && app.use('*', async (c, next) => {
        const corsMiddlewareHandler = cors(typeof options.cors === 'boolean' ? {
            origin: '*',
            allowHeaders: ['*'],
            allowMethods: ['POST', 'GET', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'],
            exposeHeaders: ['*'],
            maxAge: 600,
            credentials: true,
        } : options.cors)
        // todo handle wildcard ports in origins list (not supported in the above middleware)
        const res = await corsMiddlewareHandler(c, next)
        // todo check if response needs CORS and if it doesnt have origin or some other error, it should be logged(based on configured log level)
        if(res){
            // console.log('CORS preflight request:', res, res.ok, res.body, res.status, JSON.stringify([...res.headers.entries()]), c.req.header("origin"))
            return res
        }
        return res
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
