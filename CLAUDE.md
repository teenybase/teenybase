# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Teenybase is a lightweight backend framework for building serverless backends using TypeScript, SQLite (Cloudflare D1), and Cloudflare Workers. The entire database schema, auth, CRUD, and access rules are defined in a single `DatabaseSettings` config object (typically in `teeny.config.ts`). Pre-alpha, version 0.0.11.

## Commands

### Build
```bash
npm run build          # Full build: tsc (main) + tsc (node declarations) + esbuild (CLI bundle)
npm run watch          # Watch mode for all build steps
npm run check          # Type-check only (no emit)
```

## Important Notes

- Keep the edits quick, minimal, and accurate
- Don't create unnecessary files
- Check wiki/MEMORY_MAP.md instead of trying to build the complete context
- Ask for clarifications when in doubt
- Do not use any hacks, all code written should take care of all edge cases. If there are known issues or cases where any code might break, it should be added as a todo comment near the code.
- Written code should be free of security issues and should use best practices in terms of both security and performance.
- Do not lie, if there was an issue, tell about it, so we can find a solution, instead of making stuff up.
- Every line in commits will be checked before merging to main, and since many people are working on the project, there could be many conflicts, make edits accordingly.

### Test
```bash
npm test                          # Full: type-check + unit tests + worker tests
npm run vitest                    # Unit tests only (excludes test/worker)
npm run vitest-worker             # Worker integration tests only (Cloudflare Workers pool)

# Single test file
npx vitest run test/utils/jsepToSql.test.ts
npx vitest run -r test/worker test/worker/tableCrudExtension.test.ts

# Single test by name
npx vitest run -t "test name pattern"
```

### Worker tests require special setup
Worker tests use `@cloudflare/vitest-pool-workers` and run inside miniflare with D1/R2 bindings. Config is at `test/worker/vitest.config.ts`. Tests use `SELF.fetch()` from `cloudflare:test` to make requests. Database settings are passed via a custom `$DB_TEST_DATABASE_SETTINGS` header per request.

## Architecture

### Layered structure

**Types & Validation** (`src/types/`, `src/types/zod/`) — `DatabaseSettings` is the central config type. Every user-facing input has a corresponding Zod schema for runtime validation.

**SQL Engine** (`src/sql/`) — Three subsystems:
- `parse/` — Converts query params and rule expressions to typed SQL query objects (uses `jsep` expression parser)
- `build/` — Converts query objects to parameterized D1-compatible SQL strings
- `schema/` — Generates DDL migrations by diffing old vs new `DatabaseSettings`

**Worker Runtime** (`src/worker/`) — Runs on Cloudflare Workers:
- `$Database` (62KB) — Central orchestrator: manages tables, auth, routing, SQL execution. Created per-request via Hono middleware.
- `$Table` (34KB) — Single table: CRUD operations, rule enforcement, file handling, extension hooks.
- `teenyHono()` in `honoApp.ts` — Factory that creates the Hono app with CORS, logging, error handling. Routes `/api/*` through `$Database.route()`.

**Extensions** (`src/worker/extensions/`) — Hook-based lifecycle pattern:
- `TableCrudExtension` — REST CRUD routes (select/list/insert/update/delete)
- `TableRulesExtension` — Row-level security via expression-to-SQL WHERE clause injection
- `TableAuthExtension` (47KB) — Full auth: sign-up, login, password reset, email verify, JWT, OAuth
- Base classes: `TableExtension` (table-level hooks) and `$DBExtension` (database-level routes)

**CLI** (`src/node/`) — Built with `cac`. Commands: generate, migrate, deploy, secrets, dev, backup, build, exec. Uses `wrangler` under the hood.

**Library exports**: `.` (types/schemas/utils), `./worker` (runtime classes), `./node/*` (CLI), `./scaffolds/*` (field templates).

### Request flow
1. Hono receives request → CORS/logging middleware
2. `$Database` created per-request via `createDb` callback
3. Auth initialized from JWT bearer token
4. Route matched via `$Database.route()` → delegates to table extensions or DB extensions
5. Extension handler parses query, applies rules (WHERE clause injection), executes SQL via D1
6. JSON response returned

### Key patterns

- **ESM throughout** — `"type": "module"` in package.json, ESNext target
- **`sql` tagged template** — Creates `SQLLiteral` objects for safe SQL interpolation (from `src/types/config/sqlUtils.ts`): `sql\`CURRENT_TIMESTAMP\``
- **Expression-based rules** — JS-like expressions (`auth.uid == id`, `role == 'guest'`) parsed by jsep → converted to SQL WHERE clauses
- **Parameterized queries** — All SQL uses `?` placeholders with value arrays (`D1Query = {q: string, v: any[]}`)
- **Field usages** — Fields declare semantic `usage` (e.g., `record_uid`, `auth_email`, `auth_password`) that extensions use for automatic behavior
- **Config-driven migrations** — Schema defined in `DatabaseSettings`, migrations auto-generated by diffing current config vs previously deployed

### Build outputs
- `dist/` — Main compiled output (tsc)
- `dist/node/cli.js` — Bundled CLI entry (esbuild, ESM)
- `bin/teeny.js` — CLI shim that loads `dist/node/cli.js`

## Module boundaries

- `src/worker/` — Cloudflare Workers runtime only (no Node.js APIs)
- `src/node/` — Node.js only (CLI, config loading, wrangler integration). Has its own `tsconfig.json`
- `src/types/`, `src/sql/`, `src/security/`, `src/utils/` — Shared between both environments
- `src/index.ts` — Public library exports (types, schemas, utilities)
- `src/worker/index.ts` — Public worker runtime exports

## No linter/formatter configured
The project uses only `.editorconfig` for code style. There is no ESLint or Prettier config.
