# Getting Started with Teenybase

Teenybase is a backend on Cloudflare Workers and D1 that you define in one TypeScript file, `teenybase.ts`: tables, auth, access rules and actions. From it you get a REST API, OpenAPI docs with Swagger UI, and an admin panel. There is no backend code to write, no ORM and no route files.

This guide takes you from an empty folder to a local API you can call with curl, then to a deploy on your own Cloudflare account. Start a new project with [Option A](#option-a-new-project), or add teenybase to an existing project with [Option B](#option-b-add-to-existing-project).

**Prerequisites:** Node.js 22 or newer. You don't need a Cloudflare account for local development. The commands below use the `teeny` CLI: install it with `npm i -g teenybase`, or run each command as `npx teenybase <command>` instead of `teeny <command>`. Don't use `npx teeny`: it downloads an unrelated npm package named `teeny`.

**Using an AI coding agent?** Point it at the `teenybase` skill (`npx teenybase skills` lists it) or install the Claude Code plugin; the skill tells the agent how to work out what you are building before it edits `teenybase.ts`.

## Non-Interactive Flags

In scripts, CI and agents, pass these flags. Without them, a command that needs to ask a question fails with exit code 1 when stdin is not a terminal, and the error names the flag to pass.

| Flag | What it does |
|---|---|
| `-t, --template <template>` | Template: `with-auth` (users + auth + rules) or `blank` (empty). |
| `-y, --yes` | Skip all confirmation prompts, use defaults. |

## Option A: New Project

```bash
teeny create my-app -t with-auth -y
cd my-app
```

Creates the directory, scaffolds all files, runs `npm install`. The `with-auth` template includes a `users` table with email/password auth and row-level security. Use `-t blank` for an empty project.

## Option B: Add to Existing Project

```bash
npm install teenybase hono
npm install -D wrangler @cloudflare/workers-types typescript
teeny init -y
```

`teeny init` detects existing files and only creates what's missing. It won't overwrite `package.json` or `tsconfig.json` (only patches in the `"virtual:teenybase"` path alias). Since it doesn't modify `package.json`, install deps yourself with the `npm install` lines above.

## Key Files

| File | Purpose |
|---|---|
| `teenybase.ts` | Backend config — tables, fields, auth, rules, actions. The main file you edit. |
| `src/index.ts` | Worker entry point. Usually unchanged unless you need custom routes or R2 storage. |
| `wrangler.jsonc` | Cloudflare Workers config, D1/R2 bindings. |
| `.dev.vars` | Local secrets (JWT_SECRET, JWT_SECRET_USERS, ADMIN_JWT_SECRET, ADMIN_SERVICE_TOKEN, POCKET_UI_VIEWER_PASSWORD, POCKET_UI_EDITOR_PASSWORD). |
| `.prod.vars` | Production secrets (same keys, strong values). Generated with random values on the first remote deploy. |
| `migrations/` | Auto-generated SQL. Don't edit manually. |

## CLI Quick Reference

```bash
teeny create <name> [-t <tpl>] [-y]  # Scaffold new project (runs npm install)
teeny init [-t <tpl>] [-y]           # Add teenybase to existing project
teeny generate --local               # Generate migrations from config changes
teeny deploy --local                 # Apply migrations to local database
teeny dev --local                    # Start local dev server (port 8787)
teeny deploy --remote                # Deploy to your Cloudflare account (after npx wrangler login)
teeny deploy --temporary             # Deploy to a temporary Cloudflare account (no login, 60 min to claim)
teeny secrets --remote --upload      # Upload .prod.vars to production
teeny logs                           # Stream production logs
teeny docs                           # List available documentation files
teeny skills                         # List available skills with descriptions
teeny inspect [--table <n>] [--validate]  # Dump resolved DatabaseSettings as JSON
teeny --help                         # List commands and options
```

---

## How It Works

Everything about your backend lives in one file: `teenybase.ts` (or `teeny.config.ts` — [all supported names](config-reference.md)). You edit this file, apply the changes, and your API updates automatically — tables, auth, rules, docs, admin panel, everything.

```
                        ┌─────────────────────────────┐
                        │                             │
                        ▼                             │
               teenybase.ts                           │
              (define your backend)                   │
                        │                             │
                        ▼                             │
              teeny deploy --local --yes             │
             (generate SQL + apply locally)           │
                        │                             │
                        ▼                             │
              teeny dev --local                       │
              (start dev server)                      │
                        │                             │
                        ▼                             │
              test with curl / Swagger / PocketUI     │
                        │                             │
                  ┌─────┴─────┐                       │
                  │           │                       │
                  ▼           ▼                       │
             looks good?   need changes? ─────────────┘
                  │
                  ▼
      teeny deploy --remote --yes
            (deploy to production)
```

That's the whole loop. Keep `teeny dev` running: after each `teeny deploy --local` it reloads with the new config by itself. No build step, no ORM, no route files. Change the config, deploy, done.

---

## Understanding the Config

`teenybase.ts` is your entire backend definition:

```typescript
import { DatabaseSettings, TableAuthExtensionData,
         TableRulesExtensionData } from 'teenybase'
import { baseFields, authFields,                        // ① Pre-built field sets
         createdTrigger, updatedTrigger } from 'teenybase/scaffolds/fields'

export default {
    appUrl: 'http://localhost:8787',                     // ② Used for OAuth redirects and email links
    jwtSecret: '$JWT_SECRET',                            // ③ Secret from .dev.vars ($-prefixed = env var)
    tables: [{
        name: 'users',                                   // ④ Table name → /api/v1/table/users/
        autoSetUid: true,                                // ⑤ Auto-generate unique ID on insert
        fields: [
            ...baseFields,                               // ⑥ id + created + updated
            ...authFields,                               // ⑦ username, email, email_verified, password, password_salt, name, avatar, role, meta
        ],
        triggers: [createdTrigger, updatedTrigger],      // ⑧ Auto-manage created/updated timestamps
        extensions: [
            { name: 'auth',                              // ⑨ Enables sign-up, login, password reset, OAuth
              jwtSecret: '$JWT_SECRET_USERS',
              jwtTokenDuration: 3600,
              maxTokenRefresh: 5,
            } as TableAuthExtensionData,
            { name: 'rules',                             // ⑩ Row-level security — who can read/write what
              listRule: 'auth.uid == id',                 //    Only see your own record
              viewRule: 'auth.uid == id',
              createRule: 'true',                          //    needed for sign-up (auth extension creates via insert)
              updateRule: 'auth.uid == id',
              deleteRule: 'auth.uid == id',
            } as TableRulesExtensionData,
        ],
    }],
} satisfies DatabaseSettings                             // ⑪ Type checking — IDE autocomplete for everything
```

**Key concepts:** `$` prefix resolves env vars from `.dev.vars` / `.prod.vars`. Rules are expressions — `auth.uid == id` becomes a SQL WHERE clause. Extensions add behavior (auth, rules, crud). Everything else is auto-generated: REST API, Swagger docs, admin panel.

> **Note:** The default scaffold also includes `authCookie: { name: 'teeny_auth' }` and `passwordConfirmSuffix: 'Confirm'` on the auth extension. This enables browser Auth UI and requires `passwordConfirm` in sign-up/password-reset requests.

## Local Development

After setup (Option A or B):

```bash
teeny generate --local    # Generate migrations from your config
teeny deploy --local      # Apply migrations to local SQLite database
teeny dev --local         # Start dev server at http://localhost:8787
```

Available at: health check (`/api/v1/health`), Swagger UI (`/api/v1/doc/ui`), admin panel (`/api/v1/pocket/`).

## Development Workflow

1. Edit `teenybase.ts`
2. `teeny generate --local` + `teeny deploy --local` (generate and apply migrations)
3. `teeny dev --local` (start server)
4. Test with curl / Swagger / PocketUI
5. Iterate (back to step 1) or `teeny deploy --remote` (production)

## API Endpoint Reference

Base URL: `http://localhost:8787/api/v1` (local). For deployed apps, use your Worker URL from the Cloudflare dashboard (or `wrangler deployments list`) and append `/api/v1`.

**CRUD:**
```
POST /table/{table}/insert      { "values": {...}, "returning": "*" }
GET|POST /table/{table}/select  ?where=...&order=...&limit=...
GET|POST /table/{table}/list    Same as select but returns { items, total }
GET  /table/{table}/view/{id}
POST /table/{table}/update      { "where": "id == '...'", "setValues": {...} }
POST /table/{table}/edit/{id}   { "field": "value" }
POST /table/{table}/delete      { "where": "id == '...'" }
```

**Auth:**
```
POST /table/{table}/auth/sign-up              { "username", "email", "password", "passwordConfirm", "name" }
POST /table/{table}/auth/login-password       { "identity", "password" }
POST /table/{table}/auth/refresh-token        { "refresh_token" }
POST /table/{table}/auth/request-password-reset   { "email" }
POST /table/{table}/auth/confirm-password-reset   { "token", "password", "passwordConfirm" }
POST /table/{table}/auth/request-verification     Authorization: Bearer <token>
POST /table/{table}/auth/confirm-verification     { "token" }
POST /table/{table}/auth/logout                   Authorization: Bearer <token>
POST /auth/logout                                 Clears auth cookie only
```

**Auth header:** `Authorization: Bearer <token>`

**Other:** `GET /health`, `GET /doc/ui` (Swagger), `GET /doc` (OpenAPI JSON)

## Next Steps

- [Configuration Reference](config-reference.md) — every option in teenybase.ts
- [Actions Guide](actions-guide.md) — server-side logic with typed parameters
- [Connecting Your Frontend](frontend-guide.md) — fetch examples, auth flow, CRUD
- [Recipes & Patterns](recipes.md) — copy-paste examples for common use cases
- [CLI Reference](cli.md) — all commands with full options
- [OAuth Guide](oauth-guide.md) — set up Google, GitHub, Discord, or LinkedIn login
- [API Endpoints](api-endpoints.md) — full endpoint reference
- [Adding to Existing Projects](existing-hono-project.md) — integrate teenybase into an existing Hono app

---

# Technical Appendix

## Testing the API with curl

```bash
# Sign up
curl -X POST http://localhost:8787/api/v1/table/users/auth/sign-up \
  -H 'Content-Type: application/json' \
  -d '{ "username": "testuser", "email": "test@example.com", "password": "mypassword", "passwordConfirm": "mypassword", "name": "Test User" }'
# Response includes JWT `token` and `refresh_token`.
# `passwordConfirm` is required because the with-auth template sets passwordConfirmSuffix: 'Confirm'.

# Login
curl -X POST http://localhost:8787/api/v1/table/users/auth/login-password \
  -H 'Content-Type: application/json' \
  -d '{ "identity": "test@example.com", "password": "mypassword" }'

# Query data (authenticated) — rules ensure users only see their own records
curl http://localhost:8787/api/v1/table/users/select \
  -H 'Authorization: Bearer <token-from-login>'
```

## Adding a Second Table

Example: a `posts` table linked to `users`. Add `sqlValue` to your teenybase import, then add to your `tables` array:

```typescript
{
    name: 'posts',
    autoSetUid: true,
    fields: [
        ...baseFields,
        { name: 'author_id', type: 'relation', sqlType: 'text', notNull: true,
          foreignKey: { table: 'users', column: 'id' } },
        { name: 'title', type: 'text', sqlType: 'text', notNull: true },
        { name: 'body', type: 'text', sqlType: 'text' },
        { name: 'published', type: 'bool', sqlType: 'boolean', default: sqlValue(false) },
    ],
    triggers: [createdTrigger, updatedTrigger],
    extensions: [
        { name: 'rules',
          listRule: 'published == true | auth.uid == author_id',
          viewRule: 'published == true | auth.uid == author_id',
          createRule: 'auth.uid != null & author_id == auth.uid',
          updateRule: 'auth.uid == author_id',
          deleteRule: 'auth.uid == author_id',
        } as TableRulesExtensionData,
    ],
},
```

Then run `teeny generate --local && teeny deploy --local && teeny dev --local`.

## Row-Level Security (Rules)

The `rules` extension injects SQL WHERE clauses. Rules are expressions:

```typescript
{ name: 'rules',
  listRule: 'auth.uid == owner_id', viewRule: 'auth.uid == owner_id',
  createRule: 'auth.uid != null', updateRule: 'auth.uid == owner_id',
  deleteRule: 'auth.uid == owner_id',
} as TableRulesExtensionData
```

**Variables:** `auth.uid` (authenticated user's ID, null if not logged in), any column name, `true`/`false` (allow/deny all), `null` (deny all).
**Every table needs rules or `public: true`.** A table with no `rules` extension is denied to everyone but admins, and `teeny generate`/`deploy` refuse to run until you add rules or mark it `public: true` (open read and write for everyone). See [Access Control Defaults](config-reference.md#access-control-defaults).
**Operators:** `==`, `!=`, `>`, `<`, `>=`, `<=`, `~` (LIKE), `!~` (NOT LIKE), `in`, `@@` (FTS), `&` (AND), `|` (OR). [Full syntax](config-reference.md#expression-syntax).

## Environment Variables (Secrets)

`$`-prefixed values in `teenybase.ts` resolve from `.dev.vars` (local) or `.prod.vars` (production, uploaded via `teeny secrets --remote --upload`).

Default `.dev.vars` (generated by `teeny create`):
```env
JWT_SECRET=dev-jwt-secret-change-in-production
JWT_SECRET_USERS=dev-users-jwt-secret-change-in-production
ADMIN_JWT_SECRET=dev-admin-jwt-secret-change-in-production
ADMIN_SERVICE_TOKEN=dev-admin-token
POCKET_UI_VIEWER_PASSWORD=viewer
POCKET_UI_EDITOR_PASSWORD=editor
# Uncomment to include error details in API responses during local development.
# Never set this in .prod.vars or in production vars.
# RESPOND_WITH_ERRORS=true
```

`JWT_SECRET` and `JWT_SECRET_USERS` are **concatenated** for user auth token signing — use different values. See [How JWT Signing Works](config-reference.md#how-jwt-signing-works). `apiRoute` is stored in `infra.jsonc` (auto-saved on deploy). Never commit `.prod.vars`.

## Field Scaffolds

Import from `teenybase/scaffolds/fields`:

| Scaffold | Fields |
|---|---|
| `baseFields` | `id` (text PK, auto-UID), `created` (auto-set), `updated` (auto-set) |
| `authFields` | `username`, `email`, `email_verified`, `password` (hidden), `password_salt` (hidden), `name`, `avatar` (R2 file), `role`, `meta` (json) |
| `createdTrigger` | Prevents updating `created` after insert |
| `updatedTrigger` | Auto-updates `updated` on every update |

## Extensions (OpenAPI & PocketUI)

Both are added in `src/index.ts`:

```typescript
import { OpenApiExtension, PocketUIExtension } from 'teenybase/worker'
db.extensions.push(new OpenApiExtension(db))    // /api/v1/doc (JSON) + /api/v1/doc/ui (Swagger)
db.extensions.push(new PocketUIExtension(db))   // /api/v1/pocket/ (admin panel)
```

**OpenAPI:** pass `false` to disable Swagger UI (`new OpenApiExtension(db, false)`). See [config ref](config-reference.md#openapi-extension).

**PocketUI:** login with `POCKET_UI_VIEWER_PASSWORD` (read-only) or `POCKET_UI_EDITOR_PASSWORD` (read+write) from `.dev.vars`/`.prod.vars`. Also accepts `ADMIN_SERVICE_TOKEN`. Change defaults before production. See [config ref](config-reference.md#pocketui-extension).

## Email, OAuth & More

Add `email` and `authProviders` to your config (alongside existing `appUrl`, `jwtSecret`, `tables`):

```typescript
email: {
    from: 'noreply@yourdomain.com',
    mock: true,                       // logs to console in dev
    variables: { company_name: 'My App', company_url: 'http://localhost:8787',
                 company_address: '', company_copyright: '© 2025 My App',
                 support_email: 'support@yourdomain.com' },
    // Production: resend: { RESEND_API_KEY: '$RESEND_API_KEY' }
},
authProviders: [
    { name: 'google', clientId: '$GOOGLE_CLIENT_ID', clientSecret: '$GOOGLE_CLIENT_SECRET' },
],
```

`email` enables verification + password reset endpoints. `authProviders` enables OAuth login. See [OAuth Guide](oauth-guide.md) and [Configuration Reference](config-reference.md).

## Deploy to Production (your Cloudflare account)

Deploy to your own Cloudflare account. Full control, your Workers, your D1 database. Requires a Cloudflare account (Workers free plan is enough to start).

```bash
npx wrangler login                    # one-time: authenticate with Cloudflare (opens a browser)
npx teenybase deploy --remote --yes   # create D1, generate + upload secrets, deploy, apply migrations
```

That's all; there is nothing to create or paste by hand. The first deploy:

- **Picks the account.** `account_id` in `wrangler.jsonc` wins, then the `CLOUDFLARE_ACCOUNT_ID` environment variable. If neither is set, teeny asks wrangler which accounts your login has (`wrangler whoami`). With one account it uses it and saves it as `account_id` in `wrangler.jsonc`. With several, it asks which one, or with `--yes` fails and lists them so you can set `account_id`.
- **Creates the D1 database.** `"database_id": "TEENY_AUTO_CREATE"` (the scaffold's default) is replaced by the id of a new database named after `database_name`, written back to `wrangler.jsonc`. Commit `wrangler.jsonc` afterwards.
- **Generates the secrets** (`JWT_SECRET`, `JWT_SECRET_USERS`, `ADMIN_JWT_SECRET`, `ADMIN_SERVICE_TOKEN`, `POCKET_UI_VIEWER_PASSWORD`, `POCKET_UI_EDITOR_PASSWORD`) with random values into `.prod.vars` (only the ones missing there) and uploads them together with the worker. Keep `.prod.vars` private; it's gitignored.
- **Applies the migrations** through the new worker's admin API and deploys the full config. The worker URL is saved in `infra.jsonc`.

**CI or other non-browser setups:** instead of `wrangler login`, set `CLOUDFLARE_API_TOKEN` (a token with Workers Scripts and D1 edit permissions) and `CLOUDFLARE_ACCOUNT_ID`. Later deploys (`npx teenybase deploy --remote --yes`) only apply new migrations and redeploy the worker; after changing `.prod.vars`, run `npx teenybase secrets --remote --upload`.

**Logs:** `npx teenybase logs` streams the deployed worker's logs from Cloudflare's telemetry API. It needs an API token in `CLOUDFLARE_API_TOKEN` that can read Workers observability data; `npx wrangler login` alone is not enough. With only `wrangler login`, `npx wrangler tail` streams live requests instead. See [CLI Reference](cli.md#logs-name).

**Custom domain:** add `"routes": [{ "pattern": "api.myapp.com", "custom_domain": true }]` to `wrangler.jsonc`, then redeploy. Domain must have DNS on Cloudflare. Update `appUrl` in `teenybase.ts` to match.

## Try Without an Account (temporary deploy)

Deploy to a temporary Cloudflare account: no login, no signup, no card.

```bash
npx teenybase deploy --temporary --yes
```

It prints the live URL, a **claim URL** and when it expires:

- **60 minutes.** The account lasts 60 minutes from the first `--temporary` command. Running `deploy --temporary` again within that hour reuses the same account, URL and database (the clock doesn't restart).
- **Keep it by claiming it.** Open the claim URL, sign in to Cloudflare or create a free account, and finish the prompts before the hour is up. Opening the link isn't enough. The temporary account then becomes your Cloudflare account, with the Worker, its workers.dev URL and the D1 database and its data. Continue with `npx wrangler login` and `npx teenybase deploy --remote`; teeny already saved the account id in `wrangler.jsonc`, so no edits are needed. (Per Cloudflare's docs, the ids stay the same after the claim; we haven't verified a claim end to end yet.)
- **The claim URL works like a password.** Anyone who has it can take the account. Don't paste it anywhere public. teeny prints it and stores it only in `.teeny/temporary.json` (gitignored, readable only by you).
- **If nobody claims it,** about a minute or two after the hour the URL stops working (browsers show a secure-connection/TLS error, then "site can't be reached"; there is no Cloudflare notice page). Cloudflare deletes the account, the Worker, the database and all data; nothing can be recovered. The next `deploy --temporary` starts a new temporary account: new URL, empty database.
- **Limits while temporary:** one D1 database (100 MB), no R2, workers.dev URL only (no custom domain or routes). teeny refuses to deploy a config with R2 buckets, routes or other bindings Cloudflare doesn't support on temporary accounts, before creating anything.
- **Terms.** Creating the account means accepting Cloudflare's [Terms of Service](https://www.cloudflare.com/terms/) and [Privacy Policy](https://www.cloudflare.com/privacypolicy/). teeny shows this and asks first; `--yes` accepts.
- **Same user and shell.** wrangler keeps the temporary account in your user's global wrangler config directory (`~/.config/.wrangler/` on Linux, `~/Library/Preferences/.wrangler/` on macOS, `%APPDATA%\xdg.config\.wrangler` on Windows; `~/.wrangler/` instead if that exists). Run all `--temporary` commands as the same OS user with the same `HOME`; a sandbox that resets `HOME` between commands gets a new account each time.
- `--temporary` only works without a Cloudflare login. If you are logged in (`wrangler login` or `CLOUDFLARE_API_TOKEN`), use `deploy --remote` instead. It needs wrangler 4.102.0 or newer (new projects get the latest; tested with 4.150.0). Cloudflare rate-limits how many temporary accounts one network can create; if you hit it, wait or log in.

