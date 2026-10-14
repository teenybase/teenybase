---
name: teeny-migrate
description: >-
  Help with Teenybase migration, deployment, and local development workflow.
  Covers teeny deploy, dev commands. Handles local vs remote,
  first-time setup, schema changes, and common issues. Use when starting
  development, deploying, migrating, or troubleshooting.
---

# Teenybase Migration & Development Workflow

## The Core Workflow

Every time you change `teenybase.ts`:

```bash
teeny deploy --local --yes     # generate + apply migrations
teeny dev                      # start the dev server once; it reloads after each deploy --local
```

Your API is at `http://localhost:8787`. Swagger UI at `/api/v1/doc/ui`. Admin panel at `/api/v1/pocket/`.

## Production Deployment

### Your Cloudflare account

```bash
npx wrangler login              # one-time, opens a browser (or set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)
teeny deploy --remote --yes     # account from the login, D1 created, secrets generated + uploaded, migrations applied
```

Don't run `wrangler d1 create` or paste ids: `"database_id": "TEENY_AUTO_CREATE"` makes teeny create the database and write its id. `account_id` comes from `wrangler.jsonc`, then `CLOUDFLARE_ACCOUNT_ID`, then the login (saved to `wrangler.jsonc`). If the login has several accounts, `--yes` fails and lists them: set `account_id`.

### Without a Cloudflare account (temporary, 60 minutes)

```bash
teeny deploy --temporary --yes  # live URL + claim URL + expiry; no login
```

Give the user the claim URL privately (it works like a password) and tell them: open it and sign in or sign up **within 60 minutes of the first `--temporary` command**, or Cloudflare deletes the account, the Worker and all data. After claiming: `npx wrangler login` then `teeny deploy --remote`. Redeploy with `--temporary` within the hour to keep the same URL and database. Limits: one D1 database, no R2, workers.dev only. Run every command as the same OS user and `HOME` (the account lives in wrangler's user config dir).

## Common Issues

### "No migrations to apply"
Config hasn't changed since last deploy. Force redeploy: `teeny deploy --remote --no-migrate`.

### Dev server shows old schema
A running `teeny dev` reloads by itself after a successful `teeny deploy --local --yes` (its log prints "Local config changed (deploy --local), reloading the dev server..."). If it doesn't: check that the deploy succeeded (exit code 0) and was run in the same project directory, then restart `teeny dev`.

### "JWT_SECRET is not defined"
Check `.dev.vars` exists with `JWT_SECRET=some-value`. For production: check `.prod.vars` and run `teeny secrets --remote --upload`.

### Migration conflicts
Pull latest → `teeny deploy --local --yes` (regenerates from merged config) → test → deploy.

### "D1 database not found" (self-hosted)
Set `"database_id": "TEENY_AUTO_CREATE"` in `wrangler.jsonc` and run `teeny deploy --remote` again: teeny creates the database and writes its id.

### "You are not logged in to Cloudflare"
Run `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`), or deploy without an account: `teeny deploy --temporary --yes`.

### Reset local database
Delete `.local-persist/` and `migrations/`, then `teeny deploy --local --yes`.

## Full CLI Reference

For all commands, flags, and options, read **`docs/cli.md`**.

Quick reference of most-used commands:

| Command | What it does |
|---------|-------------|
| `teeny create <name>` | New project (templates: `with-auth`, `blank`) |
| `teeny deploy --local --yes` | Generate + apply migrations locally |
| `teeny dev` | Start local dev server (port 8787) |
| `teeny deploy --remote` | Deploy to production + apply migrations |
| `teeny deploy --temporary --yes` | Deploy to a temporary Cloudflare account (no login, claim within 60 min) |
| `teeny secrets --remote --upload` | Upload `.prod.vars` secrets |
| `teeny exec <route> --local` | Run API route directly |
| `teeny logs [name]` | Stream live logs from deployed worker |
| `teeny logs --json --since 5m --limit 100` | Fetch recent logs as JSON (for scripting/AI) |
