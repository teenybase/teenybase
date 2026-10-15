---
name: teenybase
description: >-
  Teenybase backend framework context. Provides knowledge about DatabaseSettings
  config, field types, usages, extensions, scaffolds, CLI commands, and project
  structure. Activates when working with teenybase.ts, teenybase imports,
  or Cloudflare Workers backends using teenybase.
---

# Teenybase Framework Context

Teenybase is a lightweight backend framework — serverless on Cloudflare Workers + D1. Entire backend defined in a single `DatabaseSettings` config in `teenybase.ts`.

> **Early (v0.1).** When in doubt, read the source types in `node_modules/teenybase/dist/` or the project's `src/types/`.

## Quick Decision Tree

```
What do you need?
├─ Create or edit teenybase.ts            → use teeny-config skill
├─ Write access rules (RLS expressions)  → use teeny-rules skill
├─ Migrate, deploy, or start dev server  → use teeny-migrate skill
├─ View production logs / debug errors   → teeny logs --json --since 5m --limit 100 (needs CLOUDFLARE_API_TOKEN)
├─ Understand the framework              → continue reading below
└─ Call the API or build frontend        → read docs/api-endpoints.md + docs/frontend-guide.md
```

## Before Editing teenybase.ts

Understand what the user is building first. If they haven't said, ask them to describe what they're building and what the backend needs to do.

Users usually answer with intentions, not technical specs: "I need login", "I need a database for my recipes", "I need to process Stripe payments and track subscribers". Infer the tables, auth setup and access rules from that; don't ask for schema details up front, translate their intent into config.

Work out whether this is a **new project** (`npx teenybase create <name> -t with-auth -y`) or **adding teenybase to an existing one** (`npx teenybase init -y`, see `docs/getting-started.md` Option B). Infer it from context (an existing `package.json`, or "add a backend to my app" means an existing project). If it's unclear, ask: "Are we starting a new project or adding teenybase to an existing one?"

## Project Structure

```
my-app/
  teenybase.ts          # Backend schema — THE central config file
  src/index.ts          # Worker entrypoint (5 lines, rarely edited)
  wrangler.jsonc        # Cloudflare Workers config with D1 binding
  infra.jsonc           # CLI project config (apiRoute, committed to git)
  .dev.vars             # Local dev secrets (JWT_SECRET, etc.)
  .prod.vars            # Production secrets (never committed)
  migrations/           # Auto-generated SQL (don't edit manually)
```

## Scaffolds

Pre-built field sets from `teenybase/scaffolds/fields`:

```typescript
import { baseFields, authFields, createdTrigger, updatedTrigger } from 'teenybase/scaffolds/fields'
```

- **`baseFields`** = `[id, created, updated]` — every table should use these. `id` is text primary key with `record_uid` usage. `created`/`updated` are timestamps.
- **`authFields`** = `[username, email, email_verified, password, password_salt, name, avatar, role, meta]` — for auth tables. Password/salt are hidden from API.
- **`createdTrigger`** — prevents updating the `created` column after insert
- **`updatedTrigger`** — auto-sets `updated` to CURRENT_TIMESTAMP on every update

## Extensions

| Extension | Purpose |
|-----------|---------|
| `auth` | Sign-up, login, JWT, OAuth, password reset, email verify. Requires `jwtSecret`, `jwtTokenDuration`, `maxTokenRefresh`. |
| `rules` | Row-level security via expression-based access rules. |
| `crud` | REST CRUD endpoints (auto-included for all tables). |

## API Endpoints — Quick Reference

Every table gets endpoints at `/api/v1/table/{name}/`. Full format details in `docs/api-endpoints.md`.

**IMPORTANT:** `/insert` requires `{"values": {...}}` wrapping. Sending bare `{"title": "x"}` silently fails.

| Endpoint | Method | Body format |
|----------|--------|-------------|
| `/select` | GET/POST | `?where=...&order=-created&limit=10` or POST body |
| `/list` | GET/POST | Same as select, returns `{items, total}` |
| `/view/:id` | GET | No body |
| `/insert` | POST | `{"values": {...}, "returning": "*"}` |
| `/update` | POST | `{"where": "...", "setValues": {...}}` |
| `/edit/:id` | POST | Bare fields `{"title": "x"}`. `returning`/`or` are query params. |
| `/delete` | POST | `{"where": "..."}` |

`or: "REPLACE"` on insert/update, and `/edit/:id?or=INSERT` (INSERT OR REPLACE), return 403 for non-admin users on tables with rules unless `deleteRule` is `'true'` (no trigger on that event, never on auth tables). For per-user "create or update", insert with `"or": "IGNORE"` and a unique index, then `/update` if the insert returned `[]` (see `docs/recipes.md`, User Preferences).

**Auth endpoints** (when table has auth extension):

| Endpoint | Body |
|----------|------|
| `/auth/sign-up` | Bare fields: `{"username", "email", "password", "name"}`, plus `"passwordConfirm"` when the auth extension sets `passwordConfirmSuffix: 'Confirm'` (the with-auth scaffold does) |
| `/auth/login-password` | `{"identity": "email-or-username", "password": "..."}` |
| `/auth/refresh-token` | `{"refresh_token": "..."}` + Authorization header |

Returns `{token, refresh_token, record}`. Use `Authorization: Bearer <token>` for authenticated requests.

**SSR frontends:** If your frontend is server-side rendered (HTML generated on the worker), you must use cookie-based auth so the server knows who's logged in. Add `authCookie` to your config and set the cookie after login:
```typescript
// In teenybase.ts config:
authCookie: { name: 'auth_token', httpOnly: true, secure: true, sameSite: 'Lax', path: '/' }

// In your login handler (src/index.ts), after getting the token:
import { setCookie } from 'hono/cookie'
setCookie(c, 'auth_token', token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' })
```
Without this, SSR pages always render as "logged out" because the server can't read localStorage. See `docs/recipe-full-app.md` for a complete example.

## Built-in Tools

Both are added in `src/index.ts` via extensions. `teeny init` scaffolds them by default.

**OpenAPI / Swagger** — Add with `OpenApiExtension`.
- `/api/v1/doc` — OpenAPI 3.1.0 JSON spec. Fetch this to see all endpoints, request/response schemas, and field types. Always accurate — generated from the actual Zod validation schemas.
- `/api/v1/doc/ui` — Swagger UI for interactive testing in the browser.

**Admin Panel (PocketUI)** — `/api/v1/pocket/`
Browse tables, view/edit records. Role-based access:
- **Viewer** — read-only. Password: `POCKET_UI_VIEWER_PASSWORD` in `.dev.vars` / `.prod.vars`
- **Editor** — read + write. Password: `POCKET_UI_EDITOR_PASSWORD` in `.dev.vars` / `.prod.vars`
- **Superadmin** — full access. Uses `ADMIN_SERVICE_TOKEN`

Add with `PocketUIExtension`. Default dev passwords are `viewer` / `editor` (in `.dev.vars`). Production passwords are auto-generated on first deploy.

## Documentation

Read docs (in the `docs/` directory) when you need more detail:

| Doc | When to read |
|-----|-------------|
| `docs/api-endpoints.md` | Full request/response formats for all CRUD + auth endpoints |
| `docs/frontend-guide.md` | JavaScript fetch examples for every operation |
| `docs/config-reference.md` | Every config option with descriptions |
| `docs/actions-guide.md` | Server-side actions (SQL mode + expression mode) |
| `docs/recipes.md` | Copy-paste patterns for common use cases |
| `docs/recipe-full-app.md` | Complete working app (config + SSR frontend) |
| `docs/oauth-guide.md` | OAuth provider setup (Google, GitHub, Discord, LinkedIn) |
| `docs/cli.md` | All CLI commands with full options (incl. `teeny logs`) |

## Source of Truth

When docs might be stale, check these authoritative sources:

| What | Where |
|------|-------|
| Config options + defaults | JSDoc in `src/types/tableExtensions.ts`, `src/types/config.ts` |
| API request/response schemas | Zod schemas in `src/types/zod/sqlSchemas.ts` |
| Live API docs | Swagger UI at `/api/v1/doc/ui` |
| Expression syntax | `skills/teenybase/references/EXPRESSION_SYNTAX.md` |
| Config field reference | `skills/teenybase/references/CONFIG_QUICK_REF.md` |
