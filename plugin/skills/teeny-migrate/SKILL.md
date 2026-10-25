---
name: teeny-migrate
description: >-
  Apply Teenybase schema changes and deploy: generate and apply migrations locally, run the dev
  server, deploy to the user's Cloudflare account or a temporary one, upload secrets, read logs,
  and fix the CLI errors these steps print. Use after editing teenybase.ts, before or during a
  deploy, or when npx teenybase deploy, dev or generate fails.
license: Apache-2.0
---

# Teenybase migrations, dev server and deploys

Migrations are generated: `teenybase.ts` is the source of truth, the CLI diffs it against what was last applied and writes the SQL. Never write or edit files in `migrations/` by hand: `deploy` and `generate` reset the folder from the database first (`--clean`, on by default), so hand edits are discarded. Always run the CLI as `npx teenybase` (not `npx teeny`, an unrelated package).

## Local

```bash
npx teenybase deploy --local --yes   # after every teenybase.ts change: generate + apply to the local DB
npx teenybase dev                    # http://localhost:8787; start once, it reloads after each deploy --local
```

`npx teenybase generate --local` only writes the migration files (to review the SQL). `npx teenybase inspect --validate` checks the config. The dev server log prints `Local config changed (deploy --local), reloading the dev server...` after a deploy; if it doesn't, check that the deploy exited 0 in the same directory, then restart `dev`.

Reset the local database (deletes all local data):

```bash
rm -rf .local-persist migrations
npx teenybase deploy --local --yes
```

## Remote: the user's Cloudflare account

```bash
npx wrangler login                   # one-time, opens a browser; CI: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID instead
npx teenybase deploy --remote --yes  # every deploy: applies new migrations, then deploys the worker
```

The first deploy picks the account (`account_id` in `wrangler.jsonc`, then `CLOUDFLARE_ACCOUNT_ID`, then the login, saved to `wrangler.jsonc`), creates the D1 database (`"database_id": "TEENY_AUTO_CREATE"` is replaced by the real id: commit `wrangler.jsonc`), writes random secrets to `.prod.vars` and uploads them. Don't run `wrangler d1 create` or paste ids. `.prod.vars` is private: never commit or print it.

After editing `.prod.vars`: `npx teenybase secrets --remote --upload`. Redeploy only the worker: `npx teenybase deploy --remote --no-migrate` (stops if there are unapplied migrations).

## Remote: no Cloudflare account

```bash
npx teenybase deploy --temporary --yes   # prints the live URL, a claim URL and the expiry
```

Give the claim URL to the user privately (anyone with it can take the account) and tell them to open it and sign in or sign up **within 60 minutes of the first `--temporary` run**, or Cloudflare deletes the account, worker and data. Redeploying with `--temporary` inside the hour keeps the same URL and database. After claiming: `npx wrangler login`, then `npx teenybase deploy --remote`. Limits: one D1 database, no R2, workers.dev only. Run every command as the same OS user with the same `HOME`.

## Logs

- `npx wrangler tail` streams live requests with just `wrangler login`.
- `npx teenybase logs --json --since 5m --limit 100` fetches recent logs (needs `CLOUDFLARE_API_TOKEN` with Workers observability read; `wrangler login` is not enough).
- Locally, set `RESPOND_WITH_ERRORS=true` in `.dev.vars` to see error causes in API responses. Never in `.prod.vars`.

## Errors

| Message | Fix |
|---|---|
| `Table "x" has no access rules.` | Add a `rules` extension or `public: true` to that table (`teeny-rules` skill). |
| `Migrations folder has been modified` | Only with `--no-clean`: `migrations/` differs from what was applied. Run without `--no-clean` (the default resets the folder); put schema changes in `teenybase.ts`. |
| `migrations/ has N migration files committed to git, and the ... database has no migrations applied` | Committing `migrations/` isn't supported yet (the scaffold gitignores it): with an empty database teeny would replace the committed files, so it stops. Restore a `.local-persist/` (or the `database_id`) that has them applied, or move `migrations/` out of the project to rebuild from `teenybase.ts`. Never delete or edit committed migration files to get past it. |
| `No local persist config found` | Run `npx teenybase deploy --local` before `npx teenybase dev`. |
| `You are not logged in to Cloudflare` | Ask the user to run `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`), or use `--temporary`. |
| `Your Cloudflare login has N accounts` | Set `account_id` in `wrangler.jsonc` (or `CLOUDFLARE_ACCOUNT_ID`) to one of the listed ids. |
| `--temporary can't be used` | The user is logged in: use `--remote`. |
| `can't be deployed to a temporary Cloudflare account` | Remove the listed bindings (R2, routes) or deploy with `--remote`. |
| Config validation error | Read the field path in the message; `npx teenybase inspect --validate` reproduces it. |

More: `node_modules/teenybase/docs/cli.md` (every command and flag, https://teenybase.com/docs/reference/cli), `docs/troubleshooting.md` (https://teenybase.com/docs/reference/troubleshooting), deploy walkthrough in `docs/getting-started.md`.
