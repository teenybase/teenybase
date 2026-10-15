# Security Policy

Teenybase takes security seriously. This document covers how to report vulnerabilities, what we protect against, and what we're still working on. We believe in being transparent about both our strengths and our gaps — you deserve to know exactly what you're shipping.

## Reporting a Vulnerability

If you discover a security vulnerability in Teenybase, please report it responsibly.

**Report privately on GitHub:** [github.com/teenybase/teenybase/security/advisories/new](https://github.com/teenybase/teenybase/security/advisories/new) (GitHub private vulnerability reporting). See also [SECURITY.md](../SECURITY.md).

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge reports within 48 hours and aim to release a fix within 7 days for critical issues. We will credit reporters unless they prefer anonymity.

**Please do not** open public GitHub issues for security vulnerabilities.

---

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x (current, early) | Yes |
| 0.0.x | No |

Teenybase is early (v0.1). Security fixes are applied to the latest version only.

---

## Security Design

### Authentication

**Password hashing:** SHA-256 with per-user random salt (20 characters, generated via Web Crypto `crypto.getRandomValues()`). Passwords are concatenated with salt before hashing. Comparison uses constant-time `crypto.subtle.timingSafeEqual()` to prevent timing attacks.

> **Note:** SHA-256 is fast by design, which makes it less resistant to brute-force attacks than dedicated password hashing algorithms (bcrypt, scrypt, Argon2). Upgrading to a slower hash function is on the roadmap. In the meantime, enforce strong passwords (minimum 8 characters by default, configurable via Zod schema).

**JWT tokens:** HS256 (HMAC-SHA256) by default, via [`@tsndr/cloudflare-worker-jwt`](https://github.com/tsndr/cloudflare-worker-jwt). Tokens include `id` (the user's record id), `sub` (the user's email), `user` (username), `cid` (the auth table), `sid` (session id), `verified`, `aud` (from the `auth_audience` field, e.g. `role`), `meta` when set, and `iss`, `iat` and `exp`. Expiry duration is configurable per project.

**Refresh tokens:** Generated as UUID v4 (base64-encoded), stored in KV with TTL. New refresh token issued on every refresh (rotation). Session has a configurable max duration and max refresh count.

**Token secrets:** JWT signing uses a composite secret (`baseSecret + tableSecret`). The database-level `jwtSecret` is the base; the auth table's `jwtSecret` provides the second portion. Both should be strong, random, and stored in environment variables (`.prod.vars` or Cloudflare secrets).

### SQL Injection Prevention

**Parameterized queries everywhere.** All SQL uses `?` placeholders with value arrays. Named parameters (`{:paramName}`) in `sql` tagged templates are converted to positional `?` before execution. User input never touches SQL strings directly.

**Expression sandboxing.** Rule expressions, action WHERE clauses, and guard conditions are parsed by [jsep](https://github.com/EricSmekens/jsep) with a locked-down operator and function set:

- **Allowed operators:** `=`, `==`, `!=`, `<`, `>`, `<=`, `>=`, `~` (LIKE), `!~` (NOT LIKE), `&` (AND), `|` (OR), `+`, `-`, `*`, `/`, `||` (concat), `->`, `->>` (JSON)
- **Blocked:** `&&`, `??`, `^`, `>>`, `<<`, `>>>`, `**`, and all other bitwise operators
- **Allowed functions:** `count`, `sum`, `lower`, `upper`, `substring`, `length`, `concat`, `replace`, `unixepoch`, `datetime`, `date`, `time`, `json_set`, `json_insert`, `json_replace`, `json_patch`, `json_contains`
- **Everything else is rejected** — arbitrary function calls don't pass the parser

All parsed expressions produce parameterized SQL. No exceptions.

### Row-Level Security (RLS)

Table rules (`listRule`, `viewRule`, `createRule`, `updateRule`, `deleteRule`) are parsed into SQL WHERE clauses and injected directly into queries. Filtering happens inside SQLite — unauthorized data never leaves the database, not even as an intermediate result. This is the same approach Supabase and Postgres use, applied at the framework level.

- **Deny by default:** an omitted/`null` rule denies that operation, and a table with no `rules` extension denies all CRUD to non-admins. `teeny generate`/`deploy` refuse a table that has neither rules nor an explicit `public: true`, so a table can't end up world-writable by omission. See [Access Control Defaults](config-reference.md#access-control-defaults).
- Admin users (`auth.admin = true`) bypass all rules
- `INSERT/UPDATE OR REPLACE` (the `or: 'REPLACE'` option, and `edit/:id?or=INSERT`) is rejected with 403 for non-admin callers on a table with rules unless `deleteRule` is `'true'` (no trigger on that event, never on auth tables): SQLite deletes the conflicting row without a WHERE, so `deleteRule`/`updateRule` could not be enforced on it
- Auth routes that write the user row without table rules (change-password, password reset, email verification) only write their own fields; extra fields in the request body are ignored
- Rules can reference `auth.*` (authenticated user) and column values
- Rules are validated at config time, not just at runtime

### CORS

Default configuration allows all origins (`origin: '*'`), all methods, and all headers. This is intentional for development convenience. **For production, configure CORS via the `cors` option in `teenyHono()` to restrict origins to your frontend domain(s).**

### CSRF Protection

- **OAuth flows:** 32-character random CSRF token stored in httpOnly/secure/SameSite=Lax cookie with 10-minute TTL. Verified against the state parameter on callback.
- **Google One Tap:** Standard `g_csrf_token` cookie-vs-body verification.
- **API endpoints:** No CSRF tokens — API uses stateless Authorization header authentication, which is inherently CSRF-resistant.

### OAuth Email Verification

OAuth users are matched to existing teenybase accounts by email. An attacker who can convince an OAuth provider to issue a token for `victim@example.com` — without controlling that inbox — could otherwise sign in as the victim or pre-create an account that the victim later inherits when they sign up legitimately. This is called *pre-account-takeover*.

To block it, teenybase rejects any OAuth callback where the provider doesn't confirm email verification. The callback responds `400 Email not verified` and no user record is created or modified.

- **Trusted presets** (`google`, `linkedin`) carry `trustEmailVerified: true` — they verify email at account creation, so a missing field is safe to trust.
- **`discord`** reads the explicit `verified` field from the user object.
- **`github`** uses a custom exchange handler that fetches `/user/emails` and selects only verified addresses.
- **Custom providers** must either map a verification field (`mapping.verified`) or explicitly opt in with `trustEmailVerified: true`. The default rejects logins from providers that don't confirm verification.

See [OAuth Guide → Email Verification Trust](oauth-guide.md#email-verification-trust) for setup details.

### Encryption

Email verification and password reset tokens are encrypted with AES-GCM (Web Crypto API):
- 256-bit key derived from SHA-256 hash of the secret
- Random IV per encryption (currently 40-bit — should be 96-bit per NIST spec; fix planned)
- Authenticated encryption (GCM provides integrity + confidentiality)

### Random Number Generation

All random values (salts, CSRF tokens, UIDs, refresh tokens) use `crypto.getRandomValues()` — the Web Crypto API's cryptographically secure PRNG. No `Math.random()` is used for security-sensitive operations.

### Input Validation

All user-facing inputs are validated with [Zod](https://zod.dev/) schemas:
- Usernames: 1-32 chars, alphanumeric + underscore, must start with a letter
- Passwords: 8-255 characters
- Emails: standard email format, max 255 characters
- SQL expressions: max 1000 characters, restricted character set
- Table/column names: alphanumeric + underscore, must start with a letter or underscore, max 255 characters
- Action parameters: type-checked and strict-mode validated (extra fields rejected)

### Error Responses

Error responses carry no internal detail by default: `RESPOND_WITH_ERRORS` and `RESPOND_WITH_QUERY_LOG` are both off unless explicitly set to `"true"`. With both off, a client sees `code` and `message` only (plus field errors for input validation failures). The generated SQL, bound values and raw database errors go to the server log.

Even with the debug flags on, literal values written to password hash and salt columns, `noSelect` columns and `password`-type fields are bound to SQLite normally but rendered as `'***'` in any echoed statement or query log. See [Debug Flags](config-reference.md#debug-flags-respond_with_errors-respond_with_query_log).

---

## Known Limitations

We'd rather tell you what's missing than let you find out the hard way. These are on the roadmap but not shipped yet.

| Area | Status | Mitigation |
|------|--------|------------|
| **Rate limiting** | Not implemented | No login attempt throttling, no per-IP or per-user rate limits. Use Cloudflare's built-in rate limiting rules on your Worker for now. |
| **Brute force protection** | Not implemented | No account lockout or exponential backoff on failed logins. Mitigate with strong passwords and Cloudflare WAF rules. |
| **File upload validation** | Minimal | No file type whitelist, no file size limits enforced at the application level. R2 stores files as-is. Use Cloudflare WAF or add validation in custom routes. |
| **Password hashing algorithm** | SHA-256 (fast) | Sufficient with strong passwords, but not ideal. Upgrade to bcrypt/scrypt/Argon2 is planned. |
| **OAuth redirect validation** | Open redirect possible | OAuth callback redirect URL is not validated against an allowlist. Configure `appUrl` in your settings to limit redirect scope. |
| **AES-GCM IV length** | 40-bit (should be 96-bit) | Used only for email verification and password reset tokens. Low collision risk at current scale, but fix is planned. |

---

## Dependencies

Security-relevant dependencies:

| Package | Purpose | Notes |
|---------|---------|-------|
| `@tsndr/cloudflare-worker-jwt` | JWT sign/verify | Lightweight, Cloudflare Workers compatible |
| `hono` | HTTP framework | Handles routing, middleware, CORS |
| `zod` | Input validation | Runtime type checking for all user inputs |
| `jsep` | Expression parsing | Sandboxed — restricted operator/function set |

No native crypto libraries needed — everything uses the Web Crypto API (`crypto.subtle`), built into Cloudflare Workers. No `node:crypto`, no OpenSSL, no supply chain risk from crypto packages.

---

## Best Practices for Deploying Teenybase

1. **Set a strong `jwtSecret`** — at least 32 random characters. Never commit it to source control; use `.prod.vars` or Cloudflare secrets.
2. **Restrict CORS origins** in production — pass specific domains to `teenyHono({ cors: { origin: 'https://yourdomain.com' } })`.
3. **Enable `requireAuth`** on all mutation actions unless you explicitly want public writes.
4. **Use table rules** for row-level security instead of relying on client-side filtering. Reserve `public: true` for tables that really should be writable by anyone.
5. **Set up Cloudflare rate limiting** on your Worker to protect auth endpoints until native rate limiting is added.
6. **Keep `RESPOND_WITH_ERRORS` and `RESPOND_WITH_QUERY_LOG` off in production.** Turn them on only in `.dev.vars` for local debugging.
7. **Keep Teenybase updated** — `npm update teenybase` — security fixes ship in patch releases.
