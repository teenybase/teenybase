# Teenybase Config Quick Reference

Condensed reference for the most common lookups when editing `teenybase.ts`. For the full reference, read **`docs/config-reference.md`**. For authoritative defaults, read JSDoc in **`src/types/tableExtensions.ts`** and **`src/types/config.ts`**.

## Required Fields

### DatabaseSettings (top-level)

| Property | Type | Description |
|----------|------|-------------|
| `appUrl` | string | **Required.** App URL for OAuth redirects, email links, CORS. |
| `jwtSecret` | string | **Required.** Global JWT secret. Use `'$ENV_VAR'` for env resolution. |
| `tables` | TableData[] | **Required.** Array of table definitions. |

### Auth Extension

```typescript
{
    name: 'auth',
    jwtSecret: '$JWT_SECRET_USERS',  // required
    jwtTokenDuration: 3600,          // required (seconds)
    maxTokenRefresh: 5,              // required (0 = unlimited)
} as TableAuthExtensionData
```

All other auth options are optional with sensible defaults. See `docs/config-reference.md` or JSDoc in `src/types/tableExtensions.ts` for the full list (password confirmation, email throttling, token durations, email templates, etc.).

Email templates support per-flow overrides for both html and plain text:

```typescript
emailTemplates: {
    verification: {
        layoutHtml: '...',   // optional: override html body. String fragment, full doc, or array.
        layoutText: '...',   // optional: override plain-text body (same shape options).
    },
    passwordReset: { /* same */ },
}
```

### OAuth providers (top-level `authProviders[]`)

Built-in presets: `google`, `github`, `discord`, `linkedin`. Set `clientId` + `clientSecret`; presets fill URLs, scopes, and mappings.

For custom providers (or to override preset behavior):

```typescript
{
    name: 'my-idp', clientId: '...', clientSecret: '...',
    authorizeUrl: '...', tokenUrl: '...', userinfoUrl: '...',
    scopes: ['openid', 'email'],
    mapping: { email: 'email', verified: 'email_verified' },
    trustEmailVerified: true,   // when provider response omits verified flag, treat as verified
}
```

`trustEmailVerified` defaults to `false` — without it (and without an explicit verified flag from the provider), OAuth login is rejected (`400 Email not verified`). Built-in `google` and `linkedin` opt in. See `docs/oauth-guide.md#email-verification-trust`.

### Email providers (top-level `email`)

Pick one provider; first set wins (precedence: `mailgun > resend > cloudflare`).

Pick one provider — uncomment the block you want, leave the others out:

```typescript
email: {
    from: 'noreply@yourdomain.com',
    variables: { /* company_name, company_url, company_address, company_copyright, support_email */ },

    mailgun: { MAILGUN_API_KEY: '$MAILGUN_API_KEY', MAILGUN_API_SERVER: 'api.mailgun.net' },
    // resend: { RESEND_API_KEY: '$RESEND_API_KEY' },
    // cloudflare: {},   // Workers send_email binding; no API keys; needs `npx wrangler email sending enable <domain>`
}
```

### Rules Extension

All rule fields are optional. Default is `null` (deny all). Set `'true'` for public access.

Every table needs a `rules` extension **or** `public: true` (fully open read+write, cannot be combined with rules). A table with neither is denied to non-admins at runtime, and `teeny generate` / `deploy` / `build` fail with `Table "x" has no access rules.`. Admin-only table: `extensions: [{ name: 'rules' }]`.

```typescript
{ name: 'rules', listRule: 'true', createRule: 'auth.uid != null', ... } as TableRulesExtensionData
```

## Field Type → SQL Type Compatibility

| type | Compatible sqlTypes |
|------|---------------------|
| `text` | `text` |
| `number` | `integer`, `real` |
| `integer` | `integer` |
| `bool` | `boolean`, `integer` |
| `email` | `text` |
| `url` | `text` |
| `editor` | `text` |
| `date` | `text`, `timestamp`, `datetime`, `date`, `time` |
| `select` | `text`, `integer`, `real` |
| `json` | `text`, `json` |
| `file` | `text` |
| `relation` | `text`, `integer`, `real` |
| `blob` | `blob` |
| `password` | `text` | Hashed on write; never returned via API. Pair with `auth_password` usage and a sibling `auth_password_salt` field. The auth extension handles hashing — set the raw value, read the hash back from the DB only via internal queries. |

## Scaffold Contents

**`baseFields`** = 3 fields:
- `id` — text, primary key, `record_uid` usage, noUpdate
- `created` — date/timestamp, `record_created`, noInsert, noUpdate, default CURRENT_TIMESTAMP
- `updated` — date/timestamp, `record_updated`, noInsert, noUpdate, default CURRENT_TIMESTAMP

**`authFields`** = 9 fields:
- `username` — text, unique, `auth_username`
- `email` — text, unique, noUpdate, `auth_email`
- `email_verified` — bool, noInsert, noUpdate, `auth_email_verified`, default false
- `password` — text, noSelect, `auth_password`
- `password_salt` — text, noSelect, noInsert, noUpdate, `auth_password_salt`
- `name` — text, `auth_name`
- `avatar` — file, `auth_avatar`
- `role` — text, `auth_audience`
- `meta` — json, `auth_metadata`

## Environment Variable Resolution

Any `$`-prefixed string in config resolves from env vars at runtime:
- Local: `.dev.vars` (auto-loaded by dev server)
- Production: `.prod.vars` → `teeny secrets --remote --upload`

## Observability (wrangler.jsonc)

Not part of `teenybase.ts` — configured in `wrangler.jsonc`. Generated by `teeny init`:

```jsonc
"observability": { "enabled": true, "logs": { "invocation_logs": true, "head_sampling_rate": 1 } }
```

Stream logs with `teeny logs` (needs `CLOUDFLARE_API_TOKEN`; `wrangler login` alone is not enough). Use `teeny logs --json --since 5m --limit 100` for scripting/AI.
