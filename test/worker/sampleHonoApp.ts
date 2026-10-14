import {$Database, $Env, OpenApiExtension, teenyHono, D1Adapter} from '../../src/worker'
import {ProvidedEnv} from 'cloudflare:test'
import {Hono} from 'hono'

type Env = $Env & {Bindings: ProvidedEnv}
const app = teenyHono<Env>(async (c)=> {
    const db = new $Database(c, undefined, new D1Adapter(c.env.PRIMARY_DB), c.env.PRIMARY_R2)
    db.extensions.push(new OpenApiExtension(db, true))
    // db.extensions.push(new PocketUIExtension(db))
    return db
})

const app1 = new Hono()
app1.route('/teeny/test/v1/route/api', app) // add the same app to a custom route for testing (done in tableCrudExtension.test.ts)
app1.route('', app) // direct route
export default app1
