# AGENTS.md

Guidance for coding agents (and people) working on the Teenybase source.

## What this is

Teenybase is a backend framework for Cloudflare Workers + D1. A single `DatabaseSettings` object (usually `teenybase.ts`) defines tables, fields, auth, access rules and actions. From it Teenybase generates SQL migrations, serves a REST API with OpenAPI docs, enforces rules as SQL `WHERE` clauses, and serves an admin UI. The `teeny` CLI (`bin/teeny.js`, also `teenybase`) scaffolds, migrates, runs and deploys projects.

## Commands

```bash
npm ci                 # install + build (prepare)
npm run build          # clean dist/, tsc, bundle the CLI (esbuild -> dist/node/cli.js)
npm run check          # type-check src/
npm run test-check     # type-check test/
npm run vitest         # unit tests (node)
npm run vitest-worker  # worker tests inside workerd (test/worker/vitest.config.ts)
npm run linkcheck      # links and anchors in README and docs
```

## Layout

| Path | Contents |
|---|---|
| `src/types/` | Config types and zod schemas (`DatabaseSettings`, table and extension data) |
| `src/sql/` | Rule/expression parsing (jsep), SQL builders, schema diffing for migrations |
| `src/worker/` | Runtime: `$Database`, `$Table`, extensions (auth, CRUD, rules, OpenAPI, PocketUI), email, storage adapters |
| `src/node/` | CLI (`cli.ts`, `cli-utils.ts`, `init.ts`), config loading, wrangler integration |
| `src/scaffolds/` | Reusable field and trigger definitions (`teenybase/scaffolds/fields`) |
| `test/` | Node unit tests; `test/worker/` runs in workerd via `@cloudflare/vitest-pool-workers` |
| `docs/`, `skills/` | User docs and agent skills; both ship in the npm package |

`src/worker`, `src/sql` and `src/types` run inside workerd: no Node-only APIs there. `src/node` is Node-only, and nothing outside it imports it.

## Rules

- Find and fix the cause; no workarounds or special cases that hide a bug. If something is a known limitation, document it.
- Behaviour changes need tests. Run `check`, `test-check`, `vitest` and `vitest-worker` before you finish.
- When a feature, option or CLI flag changes, update `docs/` and `skills/` in the same change, and add a line to `CHANGELOG.md` under `Unreleased`.
- Don't commit placeholder values or TODOs for unfinished work; open an issue instead.
- In generated projects, use the `teeny` CLI rather than calling `wrangler` directly; the CLI adds resource creation and migrations around it. `wrangler login`, `whoami` and `tail` are fine to run directly.
- Security-sensitive code (auth, rules, SQL generation, error responses) gets extra care: never echo SQL or secrets in responses, keep queries parameterized.
- Cloudflare docs are available as Markdown: https://developers.cloudflare.com/style-guide/ai-tooling/index.md
