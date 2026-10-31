import {fetchMock, SELF} from "cloudflare:test";
import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {setup} from '../data/drive2/setup'
import {DatabaseSettings} from '../../src'

// Where the OAuth callback sends the browser after login: the `redirect` query of the authorize call travels in
// `state` and is validated by TableAuthExtension._validateRedirectUrl. Without allowedRedirectUrls only appUrl's
// origin is accepted (drive2 appUrl: https://localhost); anything else falls back to provider.redirectUrl/appUrl.
// The provider is a fake one, its token and userinfo endpoints are answered by fetchMock (the outbound-fetch mock of
// cloudflare:test). Files that replace globalThis.fetch must restore it (vi.stubGlobal + vi.unstubAllGlobals): the
// pool runs every file in one worker, and a leftover vi.fn() fetch made every callback here a 500.

const IDP = 'https://idp.example.com'
let base: DatabaseSettings

const withProvider = (extra: Partial<DatabaseSettings> = {}, provider: Record<string, any> = {}) => ({
    ...structuredClone(base),
    authProviders: [{
        name: 'testprov', clientId: 'cid', clientSecret: 'csecret', trustEmailVerified: true, scopes: ['email'],
        authorizeUrl: IDP + '/authorize', tokenUrl: IDP + '/token', userinfoUrl: IDP + '/userinfo', ...provider,
    }],
    ...extra,
}) as DatabaseSettings

const get = (path: string, settings: DatabaseSettings, headers: Record<string, string> = {}) =>
    SELF.fetch('https://localhost/api/v1/table/users/auth/oauth/testprov' + path, {
        redirect: 'manual',
        headers: {'$DB_TEST_DATABASE_SETTINGS': JSON.stringify(settings), 'Content-Type': 'text/plain', ...headers},
    })

/** Runs authorize + callback and returns the callback response. */
async function callback(redirect: string | undefined, settings: DatabaseSettings) {
    const auth = await get(redirect === undefined ? '' : '?redirect=' + encodeURIComponent(redirect), settings)
    expect(auth.status).toEqual(302)
    const state = new URL(auth.headers.get('location')!).searchParams.get('state')!
    const csrf = /oauth_state=([^;]+)/.exec(auth.headers.get('set-cookie') ?? '')![1]
    return get(`/callback?code=c0de&state=${encodeURIComponent(state)}`, settings, {Cookie: `oauth_state=${csrf}`})
}
/** Runs authorize + callback and returns where the callback redirects to. */
async function landing(redirect: string | undefined, settings = withProvider()) {
    const cb = await callback(redirect, settings)
    expect(cb.status, await cb.clone().text()).toEqual(302)
    return cb.headers.get('location')
}

beforeAll(async () => {
    base = await setup() as unknown as DatabaseSettings
    fetchMock.activate()
    fetchMock.disableNetConnect()
    const idp = fetchMock.get(IDP)
    idp.intercept({path: '/token', method: 'POST'}).reply(200, JSON.stringify({access_token: 'at'}), {headers: {'content-type': 'application/json'}}).persist()
    // a provider whose token endpoint is broken: an HTML error page instead of JSON
    fetchMock.get('https://broken-idp.example.com').intercept({path: '/token', method: 'POST'}).reply(500, '<html>Internal Error</html>', {headers: {'content-type': 'text/html'}}).persist()
    idp.intercept({path: '/userinfo', method: 'GET'}).reply(200, JSON.stringify({sub: 'u1', email: 'oauth-user@example.com', name: 'O'}), {headers: {'content-type': 'application/json'}}).persist()
})
afterAll(() => fetchMock.deactivate())

describe('OAuth redirect after login', () => {
    test('relative paths and appUrl-host URLs are followed', async () => {
        expect(await landing('/dashboard?tab=1')).toEqual('https://localhost/dashboard?tab=1')
        expect(await landing('https://localhost/settings')).toEqual('https://localhost/settings')
    })

    test('no redirect lands on appUrl, or provider.redirectUrl when set', async () => {
        expect(await landing(undefined)).toEqual('https://localhost')
        expect(await landing(undefined, withProvider({}, {redirectUrl: 'https://localhost/home'}))).toEqual('https://localhost/home')
    })

    test.each([
        'https://evil.example/steal',
        '//evil.example/steal',
        '/\\evil.example/steal',
        'https://localhost@evil.example/',
        'https://localhost.evil.example/',
        'javascript:alert(document.cookie)',
        'data:text/html,<script>alert(1)</script>',
    ])('a foreign target falls back to appUrl: %s', async (target) => {
        expect(await landing(target)).toEqual('https://localhost')
    })

    // 0.1.1: the check is on appUrl's origin (scheme + host + port). Before, only the hostname was compared, so every
    // one of these was followed. issues/resolved/auth-oauth-redirect-origin-and-scheme.md
    test.each([
        'javascript://localhost/%0aalert(document.cookie)',
        'intent://localhost/#Intent;scheme=https;end',
        'http://localhost/after-login',
        'http://localhost:5173/after-login',
        'https://localhost:8443/after-login',
        'myapp://localhost/callback',
    ])('same hostname, different origin falls back to appUrl: %s', async (target) => {
        expect(await landing(target)).toEqual('https://localhost')
    })

    test('with allowedRedirectUrls only exact matches are followed', async () => {
        const s = withProvider({allowedRedirectUrls: ['https://localhost/dashboard', 'https://app.example.com/welcome', 'http://localhost:5173/after-login']})
        expect(await landing('/dashboard', s)).toEqual('https://localhost/dashboard')
        expect(await landing('https://app.example.com/welcome', s)).toEqual('https://app.example.com/welcome')
        expect(await landing('http://localhost:5173/after-login', s)).toEqual('http://localhost:5173/after-login')
        expect(await landing('/settings', s)).toEqual('https://localhost')
        expect(await landing('https://app.example.com/welcome/../admin', s)).toEqual('https://localhost')
    })

    test('a custom-scheme deep link is followed only through allowedRedirectUrls', async () => {
        expect(await landing('myapp://callback')).toEqual('https://localhost')
        const s = withProvider({allowedRedirectUrls: ['myapp://callback']})
        expect(await landing('myapp://callback', s)).toEqual('myapp://callback')
        expect(await landing('myapp://callback/other', s)).toEqual('https://localhost')
    })
})

describe('OAuth callback when the provider fails', () => {
    // these used to surface as 500 with the raw TypeError/SyntaxError/network error
    test('a token endpoint that answers with a non-JSON error page is a 502', async () => {
        const res = await callback('/x', withProvider({}, {tokenUrl: 'https://broken-idp.example.com/token'}))
        expect(res.status).toEqual(502)
        expect(((await res.json()) as any).message).toEqual('OAuth provider token response is not JSON (HTTP 500)')
    })

    test('an unreachable token endpoint is a 502', async () => {
        // no intercept for this host and net connect is disabled, so fetch() rejects
        const res = await callback('/x', withProvider({}, {tokenUrl: 'https://unreachable-idp.example.com/token'}))
        expect(res.status).toEqual(502)
        expect(((await res.json()) as any).message).toEqual('OAuth provider token request failed')
    })
})
