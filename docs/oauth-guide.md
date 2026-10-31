# OAuth & Google Login

Teenybase signs users in with Google, GitHub, Discord, LinkedIn or any OAuth 2 provider you configure in `teenybase.ts`, and creates or links the user's row in your auth table.

## Setup Overview

Teenybase supports three OAuth-related flows, all configured through `DatabaseSettings`:

1. **Google One Tap** (JWT token via form POST) — simplest, no redirects
2. **OAuth2 Authorization Code** (redirect flow) — Google, Discord, LinkedIn, etc.
3. **Bearer Token Login** — for tokens obtained client-side (e.g., Firebase, Auth0)

All three create a session and return a JWT + refresh token. Flows 1 and 2 can also set an auth cookie.

All three only accept an email the provider verified, and sign in to an existing row with that email; a row whose email was never verified (e.g. someone signed up with a password using that address) is taken over first: new random password, sessions ended. See [Signing in to an existing account](config-reference.md#signing-in-to-an-existing-account). To run your own code on each sign-in, see [Sign-in hook](#sign-in-hook).

---

## 1. Google One Tap Login

Uses Google's [Sign In With Google](https://developers.google.com/identity/gsi/web) HTML API. Google sends a JWT credential directly to your backend via form POST.

### Config

```ts
// teenybase.ts
const settings: DatabaseSettings = {
  appUrl: 'https://myapp.com',
  jwtSecret: '$JWT_SECRET',
  authProviders: [
    { name: 'google', clientId: '$GOOGLE_CLIENT_ID' }
  ],
  authCookie: {              // optional: set token as cookie
    name: 'auth_token',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
  tables: [{
    name: 'users',
    // ... fields with auth extension
  }],
}
```

### Frontend

#### Login URI

```html
<div id="g_id_onload"
  data-client_id="YOUR_GOOGLE_CLIENT_ID"
  data-login_uri="https://api.myapp.com/api/v1/table/users/auth/google-login"
  data-auto_prompt="true">
</div>
<script src="https://accounts.google.com/gsi/client" async></script>
```

Google posts `credential` + `g_csrf_token` as `application/x-www-form-urlencoded` to your endpoint. Teenybase verifies the CSRF cookie, decodes the JWT credential using the Google provider in `authProviders`, finds/creates the user, and returns the session. If `authCookie` is configured, the token is also set as a cookie.

**Endpoint:** `POST /api/v1/table/{auth_table}/auth/google-login`


#### SPA

For SPAs, use the Google JS API to get the credential client-side, then send it to the `login-token` endpoint as a Bearer token:

```js
google.accounts.id.initialize({
  client_id: 'YOUR_GOOGLE_CLIENT_ID',
  callback: async (response) => {
    const res = await fetch('/api/v1/table/users/auth/login-token', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${response.credential}` },
    })
    const { token, refresh_token, record } = await res.json()
    localStorage.setItem('auth_token', token)
    localStorage.setItem('refresh_token', refresh_token)
  },
})
google.accounts.id.prompt() // show One Tap UI
```

Then use the stored token for subsequent requests:

```js
fetch('/api/v1/table/posts', {
  headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` },
})
```

---

## 2. OAuth2 Redirect Flow

For standard OAuth2 authorization code flow with any provider.

### Config

```ts
const settings: DatabaseSettings = {
  // ... base config + authCookie (recommended for redirect flow)
  authProviders: [
    {
      name: 'google',  // preset: URLs + scopes auto-filled
      clientId: '$GOOGLE_CLIENT_ID',
      clientSecret: '$GOOGLE_CLIENT_SECRET',
      redirectUrl: 'https://myapp.com/dashboard', // where to land after login
    },
    {
      name: 'discord',  // preset available
      clientId: '$DISCORD_CLIENT_ID',
      clientSecret: '$DISCORD_CLIENT_SECRET',
    },
    {
      name: 'custom-provider',  // fully manual
      authorizeUrl: 'https://provider.com/oauth/authorize',
      tokenUrl: 'https://provider.com/oauth/token',
      userinfoUrl: 'https://provider.com/api/userinfo',
      clientId: '$CUSTOM_CLIENT_ID',
      clientSecret: '$CUSTOM_CLIENT_SECRET',
      scopes: ['openid', 'email'],
      mapping: { email: 'email_address', avatar: 'photo_url' },
    },
  ],
}
```

**Built-in presets:** `google`, `github`, `discord`, `linkedin` (auto-fill URLs, scopes, field mappings).

### Email Verification Trust

Teenybase only accepts OAuth logins where the provider confirms the user's email is verified:

- **Explicit truthy** (e.g., `email_verified: true`) — user signed in, marked verified.
- **Explicit falsy** (e.g., `email_verified: false`) — login rejected with `400 Email not verified`.
- **Field missing** — falls back to `trustEmailVerified`. Default `false` rejects the login.

Rejection responds with a plain `400` to the OAuth callback URL — same shape as all other OAuth callback failures (invalid state, CSRF mismatch, etc.). No redirect-with-error-query; the browser lands on the raw error page. If you need user-facing error UX, intercept the callback path in your frontend or proxy.

Built-in presets handle this for you:

| Preset | How verification is determined |
|---|---|
| `google` | `trustEmailVerified: true` — Google verifies email at account creation. |
| `linkedin` | `trustEmailVerified: true` — LinkedIn verifies email at account creation. |
| `discord` | Reads explicit `verified` field from the Discord user object. |
| `github` | Custom exchange handler fetches `/user/emails` and selects only verified addresses. |

**Custom providers** must declare how to verify. The `verified` mapping defaults to `email_verified`; if your provider returns a different field name, remap it:

```ts
{
  name: 'my-idp',
  // ... URLs + credentials
  mapping: { verified: 'email_is_verified' }, // whatever your provider returns
}
```

Or, if the provider doesn't return a verification field but you know it verifies email:

```ts
{
  name: 'my-idp',
  // ...
  trustEmailVerified: true,
}
```

**Why this matters.** If teenybase accepted unverified emails, an attacker could register at the OAuth provider claiming a victim's email (without controlling the inbox), sign in to teenybase, and have an account created under the victim's email. When the real victim later signs up via the same provider, they'd inherit the attacker-controlled record. This is called *pre-account-takeover*. The strict default blocks the attack and forces custom-provider integrators to assert their trust explicitly.

### Frontend

Just link to the authorize endpoint:

```html
<a href="https://api.myapp.com/api/v1/table/users/auth/oauth/google">
  Sign in with Google
</a>

<!-- Pass a redirect URL to land somewhere specific after login -->
<a href="https://api.myapp.com/api/v1/table/users/auth/oauth/google?redirect=/settings">
  Sign in with Google
</a>
```

**Flow:** User clicks link -> redirected to provider -> authenticates -> redirected back to callback -> session created + cookie set -> redirected to `redirect` param (or `redirectUrl` config, or `appUrl`).

#### Redirect URL validation

The `redirect` parameter is validated to prevent open redirect attacks:

- **Relative paths** (e.g., `/settings`) are resolved against `appUrl` (e.g., `https://myapp.com/settings`).
- **No `allowedRedirectUrls` configured** (default): only URLs with `appUrl`'s origin are allowed: same scheme, host and port. `http://` for an `https://` app, another port, or `javascript:`/`intent:` URLs with the app's hostname are rejected.
- **`allowedRedirectUrls` configured**: only exact matches against that list are allowed. This is how to allow a mobile app deep link (`myapp://auth/callback`) or a frontend on another origin (e.g. a dev server at `http://localhost:5173/after-login`).
- **Rejected URLs**: silently fall back to `provider.redirectUrl`, then `appUrl`.

```ts
// Example: restrict redirects to specific URLs
{
  appUrl: 'https://myapp.com',
  allowedRedirectUrls: [
    'https://myapp.com/dashboard',
    'https://myapp.com/settings',
    'https://staging.myapp.com/dashboard',
  ],
}
```

**Endpoints:**
- `GET /api/v1/table/{auth_table}/auth/oauth/{provider}` — starts the flow
- `GET /api/v1/table/{auth_table}/auth/oauth/{provider}/callback` — handles the callback (register this as the redirect URI in your provider's dashboard)

### Custom Exchange Handlers

For providers with non-standard flows (GitHub private emails, Facebook Graph API, X/Twitter PKCE), register a custom handler:

```ts
import { TableAuthExtension } from 'teenybase/worker'

TableAuthExtension.oauthExchangeHandlers['github'] = async ({ c, code, callbackUrl, clientId, clientSecret }) => {
  // Exchange code, fetch /user + /user/emails, etc.
  return { email: 'user@example.com', name: 'User', username: 'user123' }
}
```

The framework handles CSRF, session creation, cookies, and redirect. The handler only does token exchange + user info. Return `verified: true` only for an email the provider verified: `verified: false` is rejected, and the email is what links the sign-in to an existing account.

`TableAuthExtension` is an advanced export: its members are internals that may change in minor versions. To react to sign-ins, use the [sign-in hook](#sign-in-hook).

### Sign-in hook

`db.onSignIn` hooks run on every sign-in (OAuth callback, Google One Tap, `login-token`, and password/email sign-ins) with the provider name and what the provider returned, and can update rows or refuse the sign-in by throwing. Register them where the `$Database` is created:

```ts
// src/index.ts
db.onSignIn.push(async ({provider, created, user, external, db}) => {
  if (provider !== 'github') return
  // external = {provider, providerId, email, name, avatar, username, verified, rawData: GitHub's /user response}
  await db.rawSQL({q: 'UPDATE users SET handle_set = 1 WHERE id = ? AND handle_set = 0', v: [user.id]}).run()
})
```

Arguments and rules: [config reference → Sign-in hook](config-reference.md#sign-in-hook-dbonsignin).

---

## 3. Bearer Token Login

For tokens obtained on the client side (e.g., from Firebase Auth, Auth0, or a mobile SDK).

```ts
// Frontend: send the external JWT as a Bearer token
const res = await fetch('/api/v1/table/users/auth/login-token', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${externalJwtToken}` },
})
const { token, refresh_token, record } = await res.json()
```

Teenybase verifies the token against `authProviders`, finds/creates the user, and returns a session. The issuer needs a `clientId` (the `aud` its tokens carry), and the token needs an `email` claim and `email_verified: true` (or the issuer `trustEmailVerified: true`). Access tokens from Auth0 or Clerk often carry no email: add one (Clerk: a JWT template with `"email": "{{user.primary_email_address}}"`; Auth0: a custom claim in an Action) or send the ID token. See [What a JWT issuer's token must carry](config-reference.md#what-a-jwt-issuers-token-must-carry).

```ts
authProviders: [{
  issuer: 'https://myapp.us.auth0.com/',
  jwksUrl: 'https://myapp.us.auth0.com/.well-known/jwks.json',
  clientId: '$AUTH0_CLIENT_ID',   // required: tokens for other audiences are refused
  trustEmailVerified: false,      // default; true only if the issuer never issues tokens for unverified emails
}]
```

---

## Cookie-Based Auth

When `authCookie` is configured, teenybase reads the token from the cookie on every request (after checking the `Authorization` header). Cookies are set automatically on OAuth redirect flows (Google One Tap, OAuth callback).

For JSON endpoints (`login-password`, `sign-up`), the token is returned in the response body — your app sets the cookie:

```ts
// After calling login-password or sign-up, set the cookie server-side (SSR)
const { token } = await response.json()
setCookie('auth_token', token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' })

// Subsequent requests — cookie is sent automatically by the browser
const res = await fetch('/api/v1/table/posts', { credentials: 'include' })
```

**Logout** (clears cookie + invalidates session):
- Table-level: `POST /api/v1/table/{auth_table}/auth/logout`
- Global (cookie only): `POST /api/v1/auth/logout`

---

**See also:** [Configuration Reference](config-reference.md) | [Frontend Guide](frontend-guide.md) | [Recipe: Full App](recipe-full-app.md) | [Troubleshooting](troubleshooting.md)
