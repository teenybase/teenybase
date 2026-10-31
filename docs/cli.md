# CLI Reference

The `teenybase` npm package includes the CLI: run it as `npx teenybase <command>`, or install it globally (`npm i -g teenybase`) to get the `teeny` and `teenybase` commands. Never run `npx teeny`: that downloads an unrelated npm package.

```bash
npx teenybase <command> [options]
```

Run it with `npx teenybase`, not `npx teeny`: outside a project that has teenybase installed, `npx teeny` downloads an unrelated npm package named `teeny`. Inside such a project (or after `npm i -g teenybase`), `teeny` works too; the examples below use it.

**Non-interactive use (CI, scripts, agents).** When stdin is not a terminal, a command that would need to ask a question fails immediately with exit code 1 and names the flag that answers it (usually `--yes`). Every failure, including a failed `npm install` in `create`/`init` or a failed `wrangler deploy`, exits with a non-zero code.

---

## Global Options

These apply to most commands (generate, deploy, secrets, backup, build, exec). `--local`/`--remote` only apply to commands that accept a target. `dev` always runs locally.

| Option | Description |
|--------|-------------|
| `-c, --config <file>` | Use a specific teenybase config file |
| `-w, --wrangler <file>` | Use a specific wrangler config file |
| `--db <name>` | D1 database binding name (default: `PRIMARY_DB`) |
| `--local` | Use local database |
| `--remote` | Use remote (production) database |
| `--temporary` | Use a [temporary Cloudflare account](#temporary-deploys---temporary) (no login). Implies `--remote`. Supported by `deploy`, `generate`, `secrets` and `backup` |
| `-l, --logLevel <level>` | `info`, `warn`, `error`, or `silent` |
| `-d, --debug [feat]` | Show debug logs |
| `-f, --filter <filter>` | Filter debug logs |
| `--root <root>` | Project root directory (default: current directory) |

---

## Project Setup

### `create <name>`

Create a new teenybase project.

```bash
teeny create my-app
teeny create my-app --template blank --yes
```

| Option | Default | Description |
|--------|---------|-------------|
| `-t, --template <template>` | `with-auth` | `with-auth` or `blank` |
| `-y, --yes` | false | Skip prompts, use defaults |
| `--no-install` | | Don't run `npm install` after scaffolding |

Creates a directory, scaffolds the project, and runs `npm install`. The generated `package.json` pins `teenybase` to the exact version of the CLI that created it. If the install fails, the command exits 1 and leaves the files in place so you can fix the problem and run `npm install` yourself.

For coding agents it also writes `AGENTS.md` (the commands, the rules agents get wrong, where the docs and skills are) and a one-line `CLAUDE.md` with `@AGENTS.md`, so Claude Code reads the same notes. `init` writes the same files without overwriting: it appends the teenybase section to an existing `AGENTS.md` once (marked `<!-- teenybase -->`), and leaves an existing `CLAUDE.md` alone, printing how to import `AGENTS.md` from it if it doesn't already.

### `init`

Initialize teenybase in the current directory. Only creates files that don't already exist — never overwrites.

```bash
teeny init
teeny init --template blank
```

| Option | Default | Description |
|--------|---------|-------------|
| `-t, --template <template>` | `with-auth` | `with-auth` or `blank` |
| `-y, --yes` | false | Skip prompts, use defaults |
| `--no-install` | | Don't install dependencies after scaffolding |

**Generated files:** `package.json`, `wrangler.jsonc`, `tsconfig.json`, `teenybase.ts`, `src/index.ts`, `worker-configuration.d.ts`, `.dev.vars`, `.gitignore`, `migrations/`, `AGENTS.md`, `CLAUDE.md`

**Templates:**
- **`with-auth`** — Users table with auth (sign-up, login, JWT) and row-level security. Includes common fields (id, created, updated, username, email, password).
- **`blank`** — Empty tables. Good for starting from scratch or adding teenybase to an existing project.

---

## Development Workflow

### `deploy`

Apply migrations and deploy. This is the main command for both local development and production.

```bash
teeny deploy --local              # apply migrations locally
teeny deploy --local --yes        # skip confirmation
teeny deploy --remote             # deploy + migrate to production
teeny deploy --remote --no-migrate  # deploy worker only, skip migrations
teeny deploy --temporary --yes    # deploy to a temporary Cloudflare account (no login)
```

| Option | Default | Description |
|--------|---------|-------------|
| `--deploy` | true | Deploy the worker (skipped in local mode) |
| `--migrate` | true | Apply new migrations |
| `--clean` | true | Re-download migrations before generating |
| `-y, --yes` | false | Skip confirmation prompts |

**Which Cloudflare account** `--remote` deploys to, in order:
1. `account_id` in the wrangler config;
2. the `CLOUDFLARE_ACCOUNT_ID` environment variable;
3. the account of your wrangler login (`npx wrangler login`, or `CLOUDFLARE_API_TOKEN`), read with `wrangler whoami --json` (wrangler 4.65.0+). One account: used, and saved as `account_id` in the wrangler config. Several: you pick one; with `--yes` the command fails and lists them. Not logged in: the command fails and tells you to run `npx wrangler login` (or to use `--temporary`).

**First-time remote deploy** automatically:
1. Creates the D1 database for `"database_id": "TEENY_AUTO_CREATE"` and writes its id to the wrangler config
2. Generates missing secrets into `.prod.vars`
3. Deploys a minimal config with the secrets (`wrangler deploy --secrets-file`, so the worker never runs without them; wrangler older than 4.74.0 uploads them with `wrangler secret bulk` instead) and saves the worker URL in `infra.jsonc`
4. Sets up the database and applies migrations through the worker. If the new deployment isn't serving yet, it waits and retries for up to about a minute: setup on 401/403/404 or a network error, the migrations request only on 401/403/404 (a timeout could mean it was applied)
5. Deploys the full config

Migrations are applied through the worker's admin API (`/api/v1/setup-db`, `/api/v1/migrations`): the internal local worker (or your running `teeny dev` server) with `--local`, the deployed worker with `--remote`. With `--local`, `.local-persist/config.json` is only updated after the migrations are applied, so a failed or cancelled run leaves the local database and config unchanged.

If the final `wrangler deploy` fails after the migrations were applied, the command exits 1. The database is already migrated; fix the error and run `teeny deploy --remote` again to redeploy the worker.

**The `migrations/` folder follows the database you deploy to.** With `--clean` (the default), `deploy` and `generate` first replace the folder's `.sql` files with the migrations the target database has applied, then add new ones. A target with nothing applied yet (no `.local-persist/` locally, a new D1 remotely) has none, so the folder is emptied and generated again from `teenybase.ts`. That's how `deploy --local` followed by a first `deploy --remote` works, and why scaffolded projects keep `migrations/` in `.gitignore`.

Committing `migrations/` to git isn't supported yet (planned for 0.1.1: applying the committed files to an empty database). Until then, if the target has nothing applied and git tracks any of the `.sql` files (committed or staged), `deploy` and `generate` stop with exit code 1 before changing anything, also with `--yes`, instead of deleting them and generating a set with different names. Either restore a `.local-persist/` (or point `database_id` at a database) that has them applied, or move `migrations/` out of the project to build the database from `teenybase.ts`. Without git, or with the folder untracked, nothing changes.

> **Note:** `teeny migrate` is a deprecated alias for `teeny deploy`. If you have it in old scripts, update them.

#### Temporary deploys (`--temporary`)

```bash
teeny deploy --temporary --yes
```

Deploys to a Cloudflare [temporary account](https://developers.cloudflare.com/workers/platform/claim-deployments/) without any login, using wrangler's `--temporary` mode on every wrangler call teeny makes. At the end it prints the live URL, the claim URL and the expiry time (UTC and minutes left).

- **60-minute window**, counted from the first `--temporary` command. Later `--temporary` runs in that hour reuse the account, URL and database.
- **Claim** = open the claim URL, sign in to Cloudflare or sign up, and finish the prompts before it expires (opening the link is not enough). The account then becomes yours with everything in it. teeny writes the temporary account's id to `account_id` in the wrangler config, so after claiming, `npx wrangler login` + `teeny deploy --remote` work without edits.
- **The claim URL is a secret**: anyone with it can take the account. It is printed once at the end and saved in `.teeny/temporary.json` (mode 0600) with the account id and expiry; teeny hides wrangler's own copies and redacts it from error output.
- **Unclaimed** accounts are deleted with the Worker, the database and all data. The URL first fails with a TLS error, then stops resolving. The next `--temporary` run notices the account changed, resets `database_id` to `TEENY_AUTO_CREATE` and the saved URL, and deploys fresh (new URL, empty database).
- **Limits:** one D1 database (100 MB), no R2, no cron triggers, workers.dev only. teeny refuses configs with `r2_buckets`, `routes`/custom domains, `triggers.crons` (Cloudflare allows 0 cron triggers on these accounts, code 10072), more than one D1 database, or other bindings Cloudflare doesn't list for temporary accounts (Vectorize, AI, Browser Rendering, Images, Analytics Engine, Email, Workflows, Pipelines, Secrets Store, dispatch namespaces, Containers) before any account is created. If the temporary account already has a database with the configured `database_name`, it is reused; a database with another name (e.g. from another project deployed with `--temporary` in the same hour) is an error.
- **Terms:** creating the account accepts Cloudflare's Terms of Service and Privacy Policy. teeny prints this and asks before a new account is created; `--yes` accepts.
- **Requirements:** wrangler 4.102.0 or newer (tested with 4.150.0), and no Cloudflare login: with `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_API_KEY` set or after `wrangler login`, `--temporary` fails; use `--remote`. Can't be combined with `--local`. `teeny logs` doesn't support it.
- Right after Cloudflare creates the account its API can reject requests for a few seconds (`Authentication error [code: 10000]`); teeny retries those for up to about 40 seconds.
- wrangler stores the account in your user's config directory, so run every `--temporary` command as the same user with the same `HOME`.

### `generate`

Generate migration SQL files from config changes without deploying.

```bash
teeny generate --local
teeny generate --remote
```

| Option | Default | Description |
|--------|---------|-------------|
| `--clean` | true | Re-download migrations before generating |
| `-y, --yes` | false | Skip confirmation prompts (with `--temporary`: accept Cloudflare's terms) |

Usually you don't need this separately — `deploy` runs generate automatically. `--clean` and committed migrations work as described for [`deploy`](#deploy).

`generate` (and therefore `deploy` and `build`) fails with `Table "x" has no access rules.` if any table has neither a `rules` extension nor `public: true`. See [Access Control Defaults](config-reference.md#access-control-defaults).

### `dev`

Start the local dev server.

```bash
teeny dev
```

**Prerequisite:** Run `teeny deploy --local` first to set up the local database.

Leave `dev` running while you change `teenybase.ts`: each successful `teeny deploy --local` (which applies its migrations through the running dev server when it finds one) updates `.local-persist/config.json`, and `dev` reloads the worker with the new config within a second or two ("Local config changed (deploy --local), reloading the dev server..."). No restart needed.

**Environment variables:**
- `TEENY_DEV_PORT` — override dev server port (default: 8787)
- `TEENY_INSPECTOR_PORT` — override inspector port (default: 9229, useful for multiple dev servers)

> `dev` always runs locally. Passing `--remote` will error.

Stop it with Ctrl-C, or send SIGINT/SIGTERM to the `teeny dev` process (a process manager, `kill <pid>`): it stops wrangler and workerd, waits for them to exit, then exits.

### `build`

Build the worker for production (dry-run deploy with minification).

```bash
teeny build --local
teeny build --remote --outDir ./output
```

| Option | Default | Description |
|--------|---------|-------------|
| `--outDir <dir>` | `dist` | Output directory |

### `exec <route>`

Execute an API route with the admin service token.

```bash
teeny exec users/select --local
teeny exec users/insert --local -m POST -d '{"values":{"name":"test"}}'
teeny exec users/select --local --explain
```

| Option | Default | Description |
|--------|---------|-------------|
| `-m, --method <method>` | GET | HTTP method |
| `-d, -b, --data, --body <body>` | — | Request body (JSON) |
| `-y, --yes` | false | Skip confirmation for non-GET requests |
| `-r, --raw` | false | Output raw response |
| `--explain` | false | Dry run — show SQL queries without executing |

The route is prefixed with `/api/v1/table/` (or `/api/v1/explain/table/` with `--explain`).

### `backup`

Backup the database.

```bash
teeny backup --local
teeny backup --remote
teeny backup --temporary
```

`-y, --yes` skips confirmation prompts (with `--temporary`: accepts Cloudflare's terms if a new temporary account would be created).

Creates a timestamped directory at `db_backups/{local|remote}/{db-binding}/{timestamp}/` containing the schema, data, config, and migration history.

> **Note:** Remote backup with FTS5 tables can lock the database for a long time. Consider backing up locally or during low-traffic periods.

### `secrets`

Manage worker secrets.

```bash
teeny secrets --remote              # list keys from .prod.vars
teeny secrets --remote --upload     # upload secrets from .prod.vars
teeny secrets --temporary --upload  # same, on the temporary account
```

| Option | Default | Description |
|--------|---------|-------------|
| `--upload` | false | Upload secrets from `.prod.vars` to the worker |
| `-y, --yes` | false | Skip confirmation |

Local mode doesn't need secret uploads — `.dev.vars` is read automatically by the dev server. `--upload` uses the same account resolution as `deploy --remote`. The first deploy already uploads the secrets, so you only need this after changing `.prod.vars`.

---

## Observability

### `logs [name]`

Stream live logs from a deployed worker.

```bash
teeny logs                            # stream logs for current project
teeny logs my-app                     # stream logs for a specific worker
teeny logs --json                     # output raw JSON (newline-delimited)
teeny logs --since 1m --interval 5s   # look back 1 min, poll every 5s
teeny logs --limit 50                 # stop after 50 events (for CI)
```

| Option | Default | Description |
|--------|---------|-------------|
| `--json` | false | Output raw JSON per event (NDJSON) |
| `--since <duration>` | `5m` | How far back to start (e.g. `30s`, `5m`, `1h`) |
| `--interval <duration>` | `8s` | Polling interval |
| `--overlap <duration>` | `1m` | Overlap window to catch delayed events |
| `--limit <n>` | — | Stop after N events (for CI/scripting) |

**Credentials:** `logs` calls Cloudflare's Workers observability (telemetry) API directly and needs an API token in `CLOUDFLARE_API_TOKEN`, a token that can read Workers observability data (create one at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)). It doesn't use your `npx wrangler login`, so after only `wrangler login` it fails with "No Cloudflare credentials found". The account comes from `account_id` in the wrangler config or `CLOUDFLARE_ACCOUNT_ID`. With only a wrangler login, `npx wrangler tail <worker>` streams live requests instead.

> **Note:** Cloudflare has a ~1-2 minute ingestion delay. Logs from recent requests may take a moment to appear.

---

## Diagnostics & Reference

### `inspect`

Dump the resolved `DatabaseSettings` (the parsed `teenybase.ts` config) as JSON to stdout. Flags: `--table <name>` filters to one table; `--validate` runs the full zod schema validation and exits non-zero if invalid (useful in CI to fail builds on bad config).

### `docs`

List the documentation files included with the installed `teenybase` package, with file sizes. Useful from a Worker project to discover what reference material ships with your version. The command lists; it does not print file contents — open them with your editor or `cat`.

### `skills`

List the agent skills included with the installed `teenybase` package (`teenybase`, `teeny-rules`, `teeny-migrate`): the name, the first sentence of the `description` in its `SKILL.md`, and the directory. An agent reads `<directory>/SKILL.md` to load one. Same shape as `teeny docs` but for `skills/`.

### `migrate` (deprecated)

Deprecated alias for `teeny deploy`. Prints a deprecation warning, then runs the same handler. Use `teeny deploy` directly.

---

## Common Workflows

**New project — local development:**
```bash
teeny create my-app
cd my-app
teeny deploy --local --yes
teeny dev
```

**Schema change:**
```bash
# Edit teenybase.ts, then:
teeny deploy --local
# Test locally, then:
teeny deploy --remote
```

**First production deploy (own Cloudflare account):**
```bash
npx wrangler login
teeny deploy --remote --yes   # account from your login, D1 created, secrets generated and uploaded
```

**Try it without a Cloudflare account:**
```bash
teeny deploy --temporary --yes   # prints the live URL, the claim URL and the expiry
# claim within 60 minutes, then:
npx wrangler login
teeny deploy --remote
```

**Reset local database:**
```bash
rm -rf .local-persist migrations
teeny deploy --local --yes
```
If git tracks `migrations/`, deleting only `.local-persist/` makes `deploy --local` stop instead (see [`deploy`](#deploy)): committed migrations can't be applied to an empty database yet.

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| "No local persist config found" | Run `teeny deploy --local` before `teeny dev` |
| "Remote dev server not supported" | `dev` runs locally automatically. Passing `--remote` is rejected. |
| "No config found to build" | Run `teeny deploy` before `teeny build` |
| Migrations won't generate | Check your `teenybase.ts` for syntax errors |
| "You are not logged in to Cloudflare" | Run `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`), or use `--temporary` |
| "Your Cloudflare login has N accounts" | Set `account_id` in `wrangler.jsonc` or `CLOUDFLARE_ACCOUNT_ID` to one of the listed ids |
| "--temporary can't be used" | You're logged in to Cloudflare: use `--remote`, or `npx wrangler logout` and unset `CLOUDFLARE_API_TOKEN` |
| "can't be deployed to a temporary Cloudflare account" | Remove the listed bindings (R2, routes, cron triggers, ...) or deploy to your own account with `--remote` |
| `... failed: getaddrinfo ENOTFOUND <host>` right after a first deploy or a new custom domain | The worker is deployed; this machine's DNS still has the new name cached as missing. Wait a few minutes (or flush the DNS cache) and run `deploy` again |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TEENY_DEV_PORT` | Override dev server port (default: 8787) |
| `TEENY_INSPECTOR_PORT` | Override inspector port (default: 9229) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account for `--remote` when `account_id` isn't in the wrangler config |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token for wrangler instead of `wrangler login` (CI). Required by `logs`. Can't be combined with `--temporary` |

---

## Key Files

| File | Purpose |
|------|---------|
| `teenybase.ts` | Your backend config — schema, auth, rules, actions |
| `.dev.vars` | Local development secrets (auto-generated) |
| `.prod.vars` | Production secrets (generated on the first remote deploy; `teeny secrets --upload` after edits) |
| `.teeny/temporary.json` | Temporary account id, claim URL and expiry after `--temporary` (keep private) |
| `wrangler.jsonc` | Cloudflare Workers config |
| `infra.jsonc` | CLI project config (API route, project settings) |
| `migrations/` | Auto-generated SQL files — don't edit manually |

---

**See also:** [Getting Started](getting-started.md) | [Configuration Reference](config-reference.md) | [API Endpoints](api-endpoints.md) | [Troubleshooting](troubleshooting.md)
