import {afterEach, describe, expect, it, vi} from 'vitest'
import * as jwt from '@tsndr/cloudflare-worker-jwt'
import {JWTTokenHelper} from '../../src/security/JWTTokenHelper'
import {authProviderSchema} from '../../src/types/zod/jwtSchemas'
import {databaseSettingsSchema} from '../../src/types/zod/databaseSettingsSchema'
import {AuthProvider} from '../../src/types/config'

// External issuer tokens (0.1.1 B3, issues/resolved/auth-external-issuer-trust-defaults.md):
// verified only from the token's claim or trustEmailVerified; clientId required for 'login'/'partial' issuers;
// `sub` never used as the email in those modes.

const ISS = 'https://ext.example.com'
const SECRET = 'ext-shared-secret-0123456789'
const SUPA_ISS = 'https://abcdefgh.supabase.co/auth/v1'
const SUPA_SECRET = 'supabase-jwt-secret-0123456789'

const helper = (provider: Partial<AuthProvider>) => new JWTTokenHelper('global-secret', '$db', 'HS256', [{issuer: ISS, secret: SECRET, algorithm: 'HS256', ...provider} as AuthProvider])
const sign = (claims: Record<string, any>, secret = SECRET) => {
    const now = Math.floor(Date.now() / 1000)
    return jwt.sign({iss: ISS, iat: now, exp: now + 600, ...claims}, secret, {algorithm: 'HS256'})
}
const decode = async (h: JWTTokenHelper, token: string) => h.decodeAuth(token, '', false)
const rejects = async (p: Promise<unknown>) => {
    try { await p } catch (e: any) { return {status: e.status, message: e.message as string} }
    throw new Error('expected a rejection')
}

describe('external issuer: audience (clientId)', () => {
    it('a login-mode issuer without clientId refuses every token', async () => {
        const e = await rejects(decode(helper({}), await sign({email: 'a@example.com', email_verified: true})))
        expect(e).toEqual({status: 401, message: 'External issuer has no clientId configured'})
    })

    it('aud must be one of the client IDs (aud, azp, array forms)', async () => {
        const h = helper({clientId: ['app-1', 'app-2']})
        expect((await decode(h, await sign({aud: 'app-2', email: 'a@example.com', email_verified: true}))).sub).toEqual('a@example.com')
        expect((await decode(h, await sign({aud: ['other', 'app-1'], email: 'a@example.com', email_verified: true}))).sub).toEqual('a@example.com')
        expect((await decode(h, await sign({azp: 'app-1', email: 'a@example.com', email_verified: true}))).sub).toEqual('a@example.com')
        const e = await rejects(decode(h, await sign({aud: 'another-app', email: 'a@example.com', email_verified: true})))
        expect(e).toEqual({status: 401, message: 'Invalid audience for external issuer'})
        expect((await rejects(decode(h, await sign({email: 'a@example.com', email_verified: true})))).status).toEqual(401)
    })
})

describe('external issuer: email claim', () => {
    const h = helper({clientId: 'app'})

    it('a token with only `sub` is refused with a message about the email claim (sub is never the email)', async () => {
        const e = await rejects(decode(h, await sign({aud: 'app', sub: 'user_2abc', email_verified: true})))
        expect(e.status).toEqual(401)
        expect(e.message).toContain('External token has no email claim')
        expect(e.message).toContain('Clerk')
        expect(e.message).toContain('Auth0')
    })

    it('`email` wins over `sub`; `user_metadata.email` (user-editable in Supabase/Auth0) is never used', async () => {
        expect((await decode(h, await sign({aud: 'app', sub: 'auth0|123', email: 'b@example.com', email_verified: true}))).sub).toEqual('b@example.com')
        expect((await rejects(decode(h, await sign({aud: 'app', sub: 'x', user_metadata: {email: 'c@example.com'}, email_verified: true})))).status).toEqual(401)
    })

    it('partial mode follows the same rules', async () => {
        const p = helper({clientId: 'app', bearerMode: 'partial'})
        expect((await rejects(decode(p, await sign({aud: 'app', sub: 'user_2abc', email_verified: true})))).status).toEqual(401)
        expect((await rejects(decode(helper({bearerMode: 'partial'}), await sign({email: 'a@example.com', email_verified: true})))).message)
            .toEqual('External issuer has no clientId configured')
    })
})

describe('external issuer: email verification', () => {
    it('verified only from the claim; no claim is unverified unless trustEmailVerified', async () => {
        const h = helper({clientId: 'app'})
        expect((await decode(h, await sign({aud: 'app', email: 'a@example.com'}))).verified).toEqual(false)
        expect((await decode(h, await sign({aud: 'app', email: 'a@example.com', email_verified: true}))).verified).toEqual(true)
        expect((await decode(h, await sign({aud: 'app', email: 'a@example.com', email_verified: 'true'}))).verified).toEqual(true)
        expect((await decode(h, await sign({aud: 'app', email: 'a@example.com', verified: true}))).verified).toEqual(true)
        expect((await decode(h, await sign({aud: 'app', email: 'a@example.com', email_verified: 'yes'}))).verified).toEqual(false)
    })

    it('trustEmailVerified covers a missing claim, never an explicit false', async () => {
        const h = helper({clientId: 'app', trustEmailVerified: true})
        expect((await decode(h, await sign({aud: 'app', email: 'a@example.com'}))).verified).toEqual(true)
        expect((await decode(h, await sign({aud: 'app', email: 'a@example.com', email_verified: false}))).verified).toEqual(false)
        expect((await decode(h, await sign({aud: 'app', email: 'a@example.com', email_verified: 'false'}))).verified).toEqual(false)
    })
})

describe("'full' / 'admin' bearerMode (teenybase-to-teenybase tokens)", () => {
    // teenybase's own tokens: sub is the email, aud holds the user's roles, verified is a boolean claim
    const teenyToken = (extra: Record<string, any> = {}) => sign({sub: 'd@example.com', id: 'u1', cid: 'users', sid: 's1', aud: ['editor'], meta: {}, verified: true, admin: true, ...extra})

    it('full: no clientId needed, sub is the email, admin dropped', async () => {
        const p = await decode(helper({bearerMode: 'full'}), await teenyToken())
        expect(p).toMatchObject({sub: 'd@example.com', id: 'u1', cid: 'users', sid: 's1', aud: ['editor'], verified: true})
        expect((p as any).admin).toBeUndefined()
    })

    it('admin: admin flag kept', async () => {
        expect(((await decode(helper({bearerMode: 'admin'}), await teenyToken())) as any).admin).toEqual(true)
    })

    it('a teenybase token without a verified claim is unverified unless trustEmailVerified', async () => {
        expect((await decode(helper({bearerMode: 'full'}), await teenyToken({verified: undefined}))).verified).toEqual(false)
        expect((await decode(helper({bearerMode: 'full', trustEmailVerified: true}), await teenyToken({verified: undefined}))).verified).toEqual(true)
    })

    it('a configured clientId is still checked against aud', async () => {
        expect((await rejects(decode(helper({bearerMode: 'full', clientId: 'other'}), await teenyToken()))).status).toEqual(401)
    })
})

describe('supabase preset', () => {
    const supa = (provider: Partial<AuthProvider> = {}) => new JWTTokenHelper('global-secret', '$db', 'HS256', [{issuer: SUPA_ISS, secret: SUPA_SECRET, ...provider} as AuthProvider])
    const supaToken = (claims: Record<string, any>) => sign({iss: SUPA_ISS, aud: 'authenticated', sub: 'b0b0', email: 's@example.com', ...claims}, SUPA_SECRET)

    it("checks aud against 'authenticated' when no clientId is set", async () => {
        expect((await decode(supa(), await supaToken({user_metadata: {email_verified: true}}))).sub).toEqual('s@example.com')
        expect((await rejects(decode(supa(), await supaToken({aud: 'anon'})))).message).toEqual('Invalid audience for supabase token')
        expect((await rejects(decode(supa({clientId: 'custom'}), await supaToken({})))).status).toEqual(401)
    })

    it('verified only from a top-level claim or trustEmailVerified, never user_metadata (was always true)', async () => {
        expect((await decode(supa(), await supaToken({}))).verified).toEqual(false)
        // user_metadata is writable by the user (supabase.auth.updateUser({data}))
        expect((await decode(supa(), await supaToken({user_metadata: {email_verified: true}}))).verified).toEqual(false)
        expect((await decode(supa(), await supaToken({email_verified: true}))).verified).toEqual(true)
        expect((await decode(supa({trustEmailVerified: true}), await supaToken({}))).verified).toEqual(true)
        expect((await decode(supa({trustEmailVerified: true}), await supaToken({email_verified: false}))).verified).toEqual(false)
    })

    it('the email is the top-level claim only; anonymous users are refused', async () => {
        const anon = await supaToken({email: '', is_anonymous: true, user_metadata: {email: 'victim@example.com', email_verified: true}})
        expect((await rejects(decode(supa({trustEmailVerified: true}), anon))).status).toEqual(401)
        const noEmail = await supaToken({email: '', user_metadata: {email: 'victim@example.com'}})
        expect((await rejects(decode(supa({trustEmailVerified: true}), noEmail))).message).toEqual('Invalid supabase token, unable to find email')
    })
})

describe('google preset', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('without clientId every Google ID token is refused (before any network call)', async () => {
        const h = new JWTTokenHelper('global-secret', '$db', 'HS256', [{name: 'google'}])
        const token = await sign({iss: 'https://accounts.google.com', aud: 'someone-elses-app', email: 'g@example.com'})
        expect(await rejects(decode(h, token))).toEqual({status: 401, message: 'Google issuer has no clientId configured'})
    })

    // tokeninfo answers with strings: email_verified "false" used to pass a truthiness check
    const tokeninfo = (body: Record<string, string>) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}})))
    const googleToken = () => sign({iss: 'https://accounts.google.com', aud: 'g-app', email: 'g@example.com'})
    const google = () => new JWTTokenHelper('global-secret', '$db', 'HS256', [{name: 'google', clientId: 'g-app'}])

    it('tokeninfo email_verified "false" is unverified and refused', async () => {
        tokeninfo({email: 'g@example.com', email_verified: 'false', aud: 'g-app', azp: 'g-app'})
        expect(await rejects(decode(google(), await googleToken()))).toEqual({status: 400, message: 'Email not verified'})
    })

    it('tokeninfo email_verified "true" signs in', async () => {
        tokeninfo({email: 'g@example.com', email_verified: 'true', aud: 'g-app', azp: 'g-app'})
        expect(await decode(google(), await googleToken())).toMatchObject({sub: 'g@example.com', verified: true, iss: 'google'})
    })
})

describe('config validation', () => {
    const issues = (p: Record<string, unknown>) => {
        const r = authProviderSchema.safeParse(p)
        return r.success ? [] : r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)
    }

    it('an issuer without clientId is a validation error that says why', () => {
        const e = issues({issuer: ISS, secret: SECRET})
        expect(e).toHaveLength(1)
        expect(e[0]).toMatch(/^clientId: clientId is required for the JWT issuer https:\/\/ext\.example\.com: tokens are accepted only when their aud/)
        expect(issues({issuer: ISS, secret: SECRET, bearerMode: 'partial'})).toHaveLength(1)
        expect(issues({name: 'google'})).toHaveLength(1)
        // the Google verifier needs it whatever the bearerMode
        expect(issues({name: 'google', bearerMode: 'full'})).toHaveLength(1)
        // an empty client ID list or string would accept nothing / aud: ""
        expect(issues({issuer: ISS, secret: SECRET, clientId: []})).toHaveLength(1)
        expect(issues({issuer: ISS, secret: SECRET, clientId: ''})).toHaveLength(1)
    })

    it('valid without clientId: full/admin issuers, hosted supabase, OAuth-only providers', () => {
        expect(issues({issuer: ISS, secret: SECRET, bearerMode: 'full'})).toEqual([])
        expect(issues({issuer: ISS, secret: SECRET, bearerMode: 'admin'})).toEqual([])
        expect(issues({issuer: SUPA_ISS, secret: SUPA_SECRET})).toEqual([])
        expect(issues({name: 'github', clientId: 'gh', clientSecret: 'x'})).toEqual([])
        expect(issues({issuer: ISS, secret: SECRET, clientId: 'app', trustEmailVerified: true})).toEqual([])
        expect(issues({name: 'google', clientId: 'g.apps.googleusercontent.com'})).toEqual([])
    })

    it('deprecated jwtAllowedIssuers follow the same rule', () => {
        const base = {tables: [], jwtSecret: 'x', appUrl: 'https://a.example.com'}
        expect(databaseSettingsSchema.safeParse({...base, jwtAllowedIssuers: [ISS]}).success).toEqual(false)
        expect(databaseSettingsSchema.safeParse({...base, jwtAllowedIssuers: [{issuer: ISS, secret: SECRET}]}).success).toEqual(false)
        expect(databaseSettingsSchema.safeParse({...base, jwtAllowedIssuers: [SUPA_ISS]}).success).toEqual(true)
        expect(databaseSettingsSchema.safeParse({...base, jwtAllowedIssuers: [{issuer: ISS, secret: SECRET, clientId: 'app'}]}).success).toEqual(true)
    })
})
