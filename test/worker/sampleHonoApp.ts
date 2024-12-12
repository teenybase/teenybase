import {$Database, $Env, OpenApiExtension, teenyHono} from '../../src/worker'
import {ProvidedEnv} from 'cloudflare:test'

type Env = $Env & {Bindings: ProvidedEnv}
const app = teenyHono<Env>(async (c)=> {
    const db = new $Database(c, undefined, c.env.PRIMARY_DB, c.env.PRIMARY_R2)
    db.extensions.push(new OpenApiExtension(db, true))
    // db.extensions.push(new PocketUIExtension(db))
    return db
})

export default app
