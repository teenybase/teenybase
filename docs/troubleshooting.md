# Troubleshooting

Error messages and fixes for the teenybase CLI, local development, deploys to Cloudflare, auth and migrations. Search this page for the message you see.

---

## Connection & Network

**DNS failures in Docker/CI** — set `AUTO_DNS=1` (uses 1.1.1.1/8.8.8.8 — breaks VPNs, only for containers). Debug with `DNS_DEBUG=1`.

---

## Email Verification

**`Email not verified` (400) on OAuth callback** — Different error. The OAuth provider didn't confirm email verification. For custom providers, either map a verification field (`mapping.verified`) or set `trustEmailVerified: true` if you trust the provider. See [OAuth Guide → Email Verification Trust](oauth-guide.md#email-verification-trust).

**`Email not verified: the token must carry email_verified: true...` (400) on `/auth/login-token`** — The external token has no `email_verified` (or `verified`) claim set to true. Add it to the token, or set `trustEmailVerified: true` on the issuer if it never issues tokens for unverified emails. Since 0.1.1 a missing claim no longer counts as verified.

**`External token has no email claim` (401)** — The token (often an Auth0 or Clerk access token) carries only `sub`. Since 0.1.1 `sub` is never used as the email. Add an `email` claim (Clerk JWT template: `"email": "{{user.primary_email_address}}"`; Auth0: a custom claim in an Action) or send the ID token.

**`clientId is required for the JWT issuer ...`** (config validation) — Since 0.1.1 every issuer in `authProviders` (in the default `'login'` or `'partial'` bearerMode) must say which audience it accepts. Set `clientId` to the `aud` your issuer puts in its tokens (Google: your OAuth client ID; Auth0: the API identifier). `Invalid audience for external issuer` (401) means the token's `aud` isn't one of them.

**`passwordCurrent is required` / `Invalid current password` (400) on change-password** — Send the current password as `passwordCurrent`. Users created by an OAuth/token sign-in never had one: they set a password with password reset.

**`To change the password use POST /auth/change-password` (400) on a record update** — A non-admin update that sets the password on a table with a password salt column can't check `passwordCurrent`; use the change-password route.

**OAuth sign-in lands on `appUrl` instead of the `redirect` you passed** — Since 0.1.1 the redirect must have `appUrl`'s exact origin (scheme, host and port), or be listed in `allowedRedirectUrls`. Add dev servers on other ports and app deep links (`myapp://...`) to `allowedRedirectUrls`.

---

## Deploy Failures

**`No wrangler config file found`** — Run `teeny init` to scaffold, or create `wrangler.jsonc` manually.

**`No config file found`** — Run `teeny init` to generate `teenybase.ts`.

**`No databases found in wrangler config`** — Add a D1 binding to wrangler.jsonc:
```jsonc
"d1_databases": [{ "binding": "PRIMARY_DB", "database_name": "my-db", "database_id": "TEENY_AUTO_CREATE" }]
```

**`Database binding PRIMARY_DB not found`** — Rename your binding to `PRIMARY_DB`, or pass `--db YOUR_NAME` to all commands.

**`No worker name found`** — Add `"name": "my-app"` to wrangler.jsonc.

**`bucket_not_found [code: 10085]`** — Create the R2 bucket: `wrangler r2 bucket create BUCKET_NAME` or use `TEENY_AUTO_CREATE`.

**`Resource already exists`** — Change the `database_name` or bucket name to something unique.

**`Unable to deploy worker`** — Read the wrangler error output above this message. Run `teeny build` for detailed build errors.

**`Failed to set up database` after deploy** — The database is set up through the deployed worker's admin API. After a first deploy teeny waits up to about a minute for the new deployment to answer (401/403/404 or network errors while it propagates). If it still fails, check the status in the message (a 403 that persists means `ADMIN_SERVICE_TOKEN` in `.prod.vars` doesn't match the worker's secret: run `teeny secrets --remote --upload`), then run `teeny deploy --remote` again.

**`404 Table not found` (or old behaviour) right after a deploy** — Cloudflare can keep serving the previous worker version for a few seconds after `wrangler deploy` finishes (on a first deploy that version has no tables yet). Retry after a few seconds.

**`You are not logged in to Cloudflare`** — `deploy --remote` reads the account from `account_id`, `CLOUDFLARE_ACCOUNT_ID`, or your wrangler login. Run `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`), or deploy without an account with `teeny deploy --temporary`.

**`Your Cloudflare login has N accounts`** — With `--yes`, teeny doesn't pick between accounts. Set `account_id` in `wrangler.jsonc` (or `CLOUDFLARE_ACCOUNT_ID`) to one of the listed ids, or run without `--yes` to choose.

**`account_id is not set ... update wrangler`** — The project's wrangler is older than 4.65.0 and can't report your accounts. Set `account_id`, or `npm install --save-dev wrangler@latest`.

**`--temporary` errors** — `--temporary can't be used`: you're logged in to Cloudflare; deploy with `--remote`, or `npx wrangler logout` and unset `CLOUDFLARE_API_TOKEN`. `needs wrangler 4.102.0 or newer`: `npm install --save-dev wrangler@latest`. `can't be deployed to a temporary Cloudflare account`: temporary accounts have no R2, custom domains/routes or more than one D1 database; remove those or use your own account. `allow one D1 database`: the temporary account already has a database from another project; claim that account, wait for it to expire, or share the database name. `Your previous temporary deployment ... has expired`: nobody claimed it within 60 minutes, so Cloudflare deleted it with its data; this deploy starts fresh.

**`Final deploy failed`** — Migrations were applied but the last `wrangler deploy` failed, so the worker still runs the previous code and config. The command exits 1. Fix the error printed above it, then run `teeny deploy --remote` again.

**`Cannot ask "...": stdin is not an interactive terminal`** — A command needed an answer while running without a terminal (CI, script, agent). Pass the flag named in the message (usually `--yes`).

**`Dependency install failed`** (`create` / `init`) — The project files were created; fix the npm error printed above, then run `npm install` in the project directory.

**`Unable to deploy secrets`** — Ensure the worker exists first. Check `wrangler login`.

**`Admin token not found in secrets file`** — Add `ADMIN_SERVICE_TOKEN=value` to `.dev.vars` or `.prod.vars`.

**`Migrations folder has been modified`** — Only printed with `--no-clean`, when `migrations/` differs from what was last applied. Run without `--no-clean`: the default `--clean` resets `migrations/` from the database (discarding hand edits) and regenerates from `teenybase.ts`.

**Cannot export with FTS5 (remote)** — Known Cloudflare bug ([workers-sdk#9519](https://github.com/cloudflare/workers-sdk/issues/9519)). Remote export with FTS5 locks the DB for hours. Workaround: drop FTS, export, re-add FTS. Local export works fine.

---

## Local Development

**`No local persist config found`** — Run `teeny deploy --local` before `teeny dev`.

**Port in use** — Stop other processes on port 8787, or set `TEENY_DEV_PORT=9090`.

**Build failure** — Run `teeny build` to see detailed errors. Check TypeScript for issues.

**`Unable to resolve virtual:teenybase`** — Run `teeny init` to add the path alias, or add manually to tsconfig.json: `"paths": { "virtual:teenybase": ["./teenybase"] }`.

**`Remote dev server not supported`** — Always use `teeny dev` (it runs locally automatically).

---

## Version & Compatibility

**Node.js** — Requires 18+. Check with `node --version`.

**Wrangler** — Requires v4+. Update: `npm install wrangler@latest`.

**Native binary mismatch** — After switching between macOS/Linux, run `npm install` to get correct platform binaries.

**Alpine/musl** — workerd needs glibc. Run `bash scripts/fix-alpine-workerd.sh` to patch. Re-run after `npm install`.

---

## Config Errors

**`Config must export or return an object`** — Your `teenybase.ts` needs `export default { ... } satisfies DatabaseSettings`.

**`Failed to load config`** — Syntax error or missing import in teenybase.ts. Run `npx tsc --noEmit` to check.

**Invalid project name** — Use lowercase alphanumeric + hyphens/dots/underscores only.

**Unknown template** — Use `--template with-auth` or `--template blank`.

---

## CRUD & API Errors

**Insert returns empty `[]`** — Three possible causes:
1. Missing `values` wrapper: send `{"values": {"title": "x"}}` not `{"title": "x"}`
2. `createRule` rejected the insert (silently filtered by CTE WHERE clause)
3. Missing `"returning": "*"` — without it, inserts don't return data

**`Cannot insert {field} field` (403)** — Field has `noInsert: true`. Remove it from request body — it's auto-managed.

**UNIQUE constraint failed** — A record with that value already exists. Use a different value. With the default settings the response only says `Failed to run insert query`; the constraint and column are in `data` when `RESPOND_WITH_ERRORS=true` (local dev) and always in `teeny logs`. Auth sign-up is the exception: a taken email or username always returns a readable message and a `data.email` / `data.username` field error (see [Frontend Guide - Sign Up](frontend-guide.md#1-sign-up)).

**NOT NULL constraint failed** — Required field missing. Include it with a non-null value.

**`Error parsing INSERT/SELECT data`** — Invalid query syntax. Check `data.error` in the response (only present when `RESPOND_WITH_ERRORS=true`; see below). Common: `&&` should be `&`, `===` should be `==`, `||` (OR) should be `|`.

**Error response has only `code` and `message`, no `data`** — Error details are off by default so production never leaks SQL or internal messages. For local debugging add `RESPOND_WITH_ERRORS=true` (and optionally `RESPOND_WITH_QUERY_LOG=true`) to `.dev.vars` and restart `teeny dev`. In production read the details from `teeny logs` instead. See [Debug Flags](config-reference.md#debug-flags-respond_with_errors-respond_with_query_log).

**Edit endpoint format** — `/edit/:id` takes bare fields `{"title": "x"}`, NOT `{"setValues": {...}}`. Use `returning` and `or` as query params.

---

## Rule & Access Errors

**`Forbidden` (403)** — The rule is `null` (the default = admin only), or the table has no `rules` extension at all (default-deny). Set the rule to `"true"` for public, or an expression like `"auth.uid == id"`.

**`Table "x" has no access rules.` from `generate`/`deploy`/`build`** — Every table needs a `rules` extension or `public: true`. Add rules (or `{name: 'rules'}` alone for an admin-only table), or set `public: true` if anyone, including unauthenticated users, should be able to read and write it. Tables without rules were fully open before 0.1.0. See [Access Control Defaults](config-reference.md#access-control-defaults).

**`'public: true' cannot be combined with a rules extension`** — Pick one. Use rules (`listRule: 'true'`, `viewRule: 'true'`, stricter write rules) for public-read tables.

**Insert silently returns `[]`** — `createRule` filtered the insert. Ensure data satisfies the rule. For sign-up tables, use `createRule: "true"`.

**`Not Found` (404) on existing record** — `viewRule`/`listRule` filtered it out. The user's `auth.uid` doesn't match the rule condition.

---

## Auth Runtime Errors

**`Invalid username or password`** — Wrong credentials. Email normalization applies: `User+tag@Gmail.com` → `user@gmail.com`.

**`Invalid session` on refresh** — Refresh token expired (7 days), already used (single-use), or password changed (invalidates all sessions). Log in again.

**`Invalid Configuration` (500)** — Missing required field usages. Auth table needs at minimum: `record_uid`, `auth_username`, `auth_password`. Use `baseFields` + `authFields` scaffolds.

**`Invalid email domain`** — Disposable email provider blocked (mailinator, yopmail, etc.). Use a real email.

**OAuth `CSRF token mismatch`** — Cookie expired (10 min) or blocked. Retry the OAuth flow with cookies enabled.

**`Email not configured` (501)** — `request-verification` / `request-password-reset` need an email provider and there is no `email` section in teenybase.ts. Add a Resend, Mailgun or Cloudflare Email Service config. Without one, users can't verify their email, so `change-password` (which needs a verified email) also stays unavailable.

**`Verification/reset email already sent`** — Rate limited (2 min cooldown). Wait and retry.

---

## Query & Expression Errors

**Expression syntax mistakes:**
- `&&` → use `&` (AND)
- `||` for OR → use `|` (`||` is string concatenation)
- `===` → use `==`
- `=` vs `==`: `=` is SQL `=` (not null-safe), `==` is SQL `IS` (null-safe). Use `==` when comparing with `null` or when null values are possible
- Unquoted strings: `status == published` → `status == 'published'`

**FTS errors** — `@@` operator requires `fullTextSearch` configured on the table. Run migrations after adding it.

---

## Cloudflare Platform Limits

| Resource | Free | Paid ($5/mo) |
|---|---|---|
| Requests | 100k/day | 10M/month + $0.30/M overage |
| Worker size (compressed) | 3 MB | 10 MB |
| CPU time/request | 10 ms | 30 s (up to 5 min with opt-in `cpu_ms`) |
| D1 database size | 500 MB | 10 GB (hard cap) |
| D1 queries/request | 50 | 1,000 |
| D1 row reads | 5M/day | 25B/month |
| D1 row writes | 100K/day | 50M/month |
| R2 storage | 10 GB | $0.015/GB |
| R2 Class A ops/mo | 1M | $4.50/M |
| R2 Class B ops/mo | 10M | $0.36/M |
| Subrequests/request | 50 | 10,000 (up to 10M) |

**Worker bundle too large** — Reduce dependencies. Check for accidentally bundled large packages. Use `teeny build` to see the output size.

**D1 size limit (10 GB)** — Hard cap, cannot be increased. Archive old data or use R2 for large blobs.

**D1 query timeout (30s)** — Optimize queries. Add indexes for filtered columns. Reduce result set size with `limit`.

---

## D1 Known Issues

**FTS5 export bug** — Remote D1 export with FTS5 virtual tables locks the database for hours. Teenybase blocks this automatically. Workaround: drop FTS, export, re-add. Tracked: [workers-sdk#9519](https://github.com/cloudflare/workers-sdk/issues/9519).

**Read replication lag** — D1 read replicas may return stale data. For consistency-critical reads, use the Sessions API or write+read in the same request.

**Single-writer bottleneck** — D1 has one write region. High write throughput may hit `D1_ERROR: database is locked`. Batch writes and avoid concurrent mutations.

---

## Logs & Observability

**No logs appearing** — Cloudflare has a ~1-2 minute ingestion delay. Make requests to your worker, wait 1-2 minutes, then check again. Ensure `observability.enabled` is `true` in wrangler.jsonc (generated by default with `teeny init`).

**`No Cloudflare credentials found`** — `teeny logs` needs `CLOUDFLARE_API_TOKEN`, a token that can read Workers observability data; `npx wrangler login` is not enough. Create a token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens), or stream live requests with `npx wrangler tail` using your wrangler login.

**`Worker not found` (404)** — The worker name doesn't match any deployed worker. Check `name` in `wrangler.jsonc` or pass the correct name: `teeny logs my-app`.

**`Cloudflare rejected the API token (HTTP 401/403)`** — The token in `CLOUDFLARE_API_TOKEN` is invalid, belongs to another account, or can't read Workers observability data. Create a new one in the Cloudflare dashboard.

**Logs appear out of order** — Events within the same request are grouped and sorted, but events across requests may arrive out of order due to distributed ingestion. This is normal.

---

## Docker & CI

**workerd on Alpine** — Needs glibc. Run `bash scripts/fix-alpine-workerd.sh`. Re-run after `npm install`.

**GitHub Actions** — Use `ubuntu-latest` + Node 22+. Alpine runners need the workerd fix.

**Miniflare in CI** — Set `NODE_ENV=test`. Local D1 state is ephemeral per test run.

---

**See also:** [Getting Started](getting-started.md) | [CLI Reference](cli.md) | [Configuration Reference](config-reference.md) | [Cost Breakdown](cost-breakdown.md)
