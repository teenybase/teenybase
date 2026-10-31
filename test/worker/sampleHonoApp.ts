import {$Database, $Env, OpenApiExtension, teenyHono, D1Adapter} from '../../src/worker'
import {ProvidedEnv} from 'cloudflare:test'
import {Hono} from 'hono'
import {HTTPException} from 'hono/http-exception'

type Env = $Env & {Bindings: ProvidedEnv}
const app = teenyHono<Env>(async (c)=> {
    const db = new $Database(c, undefined, new D1Adapter(c.env.PRIMARY_DB), c.env.PRIMARY_R2)
    db.extensions.push(new OpenApiExtension(db, true))
    // db.extensions.push(new PocketUIExtension(db))
    // authSignInHook.test.ts: an onSignIn hook, only for requests that ask for one. It records what it got in
    // _test_signin_events (created by that test), then: 'throw' fails the sign-in, 'set-role' changes an auth column.
    const hookMode = c.req.header('$DB_TEST_SIGNIN_HOOK')
    if (hookMode) db.onSignIn.push(async (e) => {
        const {db: eventDb, ...rest} = e
        await eventDb.rawSQL({q: 'INSERT INTO _test_signin_events (event) VALUES (?)', v: [JSON.stringify({...rest, sameDb: eventDb === db})]}).run()
        if (hookMode === 'throw') throw new HTTPException(403, {message: 'Blocked by the sign-in hook'})
        if (hookMode === 'set-role') await eventDb.rawSQL({q: 'UPDATE users SET role = ? WHERE id = ?', v: ['editor', e.user.id]}).run()
    })
    return db
})

const app1 = new Hono()
app1.route('/teeny/test/v1/route/api', app) // add the same app to a custom route for testing (done in tableCrudExtension.test.ts)
app1.route('', app) // direct route
export default app1
