# Changelog

All notable changes to the `teenybase` npm package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semver](https://semver.org/) with the usual 0.x caveat that minor versions may break the API.

## Unreleased

Release 0.1.0. The last version on npm is 0.0.14; 0.0.15 and 0.0.16 were never published to npm (0.0.16 was the version on GitHub `main`), so upgrading from npm 0.0.14 also brings everything that was on that `main`. The entries below are the changes since that 0.0.16 tree.

### Breaking

- **Tables with no `rules` extension now deny access by default.** List, view, insert, update and delete on such a table return 403 for anonymous and signed-in users; admin and service-token requests still work. `teeny generate`, `deploy` and `build` exit 1 naming each such table. Fix: add a `rules` extension, or set `public: true` on the table to keep the old open behaviour (`public: true` together with a `rules` extension is a validation error). See "Access Control Defaults" in [config-reference.md](docs/config-reference.md).
- **`RESPOND_WITH_ERRORS` is off unless set to `true`.** Error responses no longer include the generated SQL or its bound values; new scaffolds set it to `"false"` in `wrangler.jsonc`. For local debugging set `RESPOND_WITH_ERRORS=true` in `.dev.vars`.
- Non-admin `or: 'REPLACE'` (on `/insert`, `/update`, `/edit/:id?or=INSERT` and action steps that apply table rules) returns 403 unless the table's `deleteRule` is `'true'`, the table is not an auth table and no trigger runs on that event. Use `or: 'IGNORE'` plus an update for upserts.

### Security

- Error responses never echo SQL, password hashes or salts: password, salt and `noSelect` values are redacted at bind time, and the debug query data is returned only when both `RESPOND_WITH_ERRORS` and `RESPOND_WITH_QUERY_LOG` are on.
- `change-password` writes only the password and salt. It used to pass the whole request body to the update, so a signed-in user could also change their own `role`, `email` and other fields.
- `OR REPLACE` could delete another user's row through a unique-key conflict without checking `deleteRule`/`updateRule`; now restricted as described under Breaking.
- OAuth: a provider's email is no longer treated as verified when its userinfo response has no verification field. New per-provider option `trustEmailVerified` (default `false`); the built-in Google and LinkedIn presets set it. This closes a pre-account-takeover path through providers that don't verify email.
- The admin panel loads an exact `@teenybase/pocket-ui` version (0.0.5, `POCKET_UI_VERSION`) instead of `@latest`, so a new publish of that package can't change what runs in admin sessions. Swagger UI loads `swagger-ui-dist` 5.33.2 instead of the latest, and the admin login page's Pico CSS is pinned to 2.1.1 with Subresource Integrity.

### Added

- Cloudflare Email Service as an email provider (`email.cloudflare`, uses a Workers `send_email` binding). It is used only when Mailgun and Resend are not configured.
- Plain-text versions of the built-in email templates, sent alongside the HTML.
- `database` config field and experimental storage adapters (`d1-rest`, `libsql`, `d1-http`) plus an R2 REST adapter. Only `d1-binding` (the default) is supported by the CLI and migrations; see [config-reference.md](docs/config-reference.md#database).
- `db.registerExtension()`, `$Table.findExtension()`, and more exports from `teenybase/worker` (`MigrationHelper`, `$DatabaseRawImpl`, route types).
- `TEENYBASE_VERSION` export.
- The npm package now ships `docs/`, the core agent skills (`skills/teenybase`, `teeny-config`, `teeny-migrate`, `teeny-rules`) and the Claude Code plugin manifest, so `teeny docs` and `teeny skills` work from an install.
- Package metadata: description, keywords, repository and bug links.
- `deploy --remote` with only `npx wrangler login`: the account comes from `account_id`, then `CLOUDFLARE_ACCOUNT_ID`, then the login (saved to `wrangler.jsonc`); the D1 database is created for `"database_id": "TEENY_AUTO_CREATE"` (the scaffold default) and missing secrets are generated into `.prod.vars`. The first deploy uploads secrets together with the worker (`wrangler deploy --secrets-file`, wrangler 4.74+) and retries the first admin API calls on 401/403/404, fixing the first-deploy migration 403.
- `--temporary` (deploy, generate, secrets, backup): deploy to a Cloudflare temporary account with no login; prints the live URL, the claim URL and the expiry (60 minutes). Needs wrangler 4.102+; refuses R2, routes and other bindings temporary accounts don't support.
- `teeny dev` reloads the worker when `deploy --local` applies new migrations; no restart needed.
- `create` / `init --no-install`. Scaffolds pin `teenybase` to the exact CLI version that generated them and use `@cloudflare/workers-types` ^5.

### Removed

- Removed the hosted-platform commands (`register`, `login`, `logout`, `whoami`, `list`, `status`, `delete`) and the Teenybase Cloud deploy choice; deploys go to your own Cloudflare account only (or a `--temporary` one). Use `npx wrangler whoami` to check your Cloudflare login, and `npx wrangler delete` / `npx wrangler d1 delete` to remove a deployed worker or database.

### Changed

- Requires Node.js 22 or newer (`engines.node` `>=22`, was `>=18.14.1`). New projects install the latest wrangler 4, which refuses to start on older Node. Commands that run wrangler now stop at once with a message naming the Node version.
- `$Database` no longer requires an adapter argument; it falls back to the configured `database` (default: the `PRIMARY_DB` D1 binding).
- File-name normalisation uses a Unicode-aware snake_case conversion.
- `dist/` is cleaned before every build, so packed tarballs contain no stale files.

### Fixed

- Duplicate sign-up returns a field-level error regardless of debug flags: `{"code":400,"message":"An account with this email already exists","data":{"email":{"_errors":[...]}}}` (same for username).
- D1 errors from current workerd: the extended result code is parsed into `extendedCode` instead of producing `code: "SQLITE_CONSTRAINT_UNIQUE)"`; composite unique indexes report every column. This also revives the OAuth username-collision retry.
- `/update` with `or` built `UPDATE t OR x SET` (a syntax error); it now builds `UPDATE OR x t SET`.
- CLI: every failure exits non-zero, including a failed `npm install` in `create`/`init` and a failed final `wrangler deploy`. Without a terminal, a command that needs an answer fails at once and names the flag (usually `--yes`).
- CLI: `deploy --local` writes `.local-persist/config.json` only after the migrations are applied, and sets up the database through the worker API directly instead of retrying a direct-D1 path that could not run batches.
- CLI: runs wrangler as `node <wrangler bin>` without a shell, fixing `spawn npx ENOENT` on Windows. Thanks to @izulwahidin for reporting it (#1) and for the first fix (PR #3).
- `zod`, `esbuild`, `miniflare` and `undici` are declared dependencies; `@cloudflare/workers-types` ^5 is accepted.
- Applying migrations no longer fails when only the stored `sql_revert` differs from the local file.
- Wrangler warnings on stderr no longer break the CLI's parsing of wrangler's JSON output.
- Broken documentation links (self-hosting anchor, JWT library link).

### Docs

- Docs and skills describe deploying to your own Cloudflare account only.
- Getting Started opens for a human reader; the agent guidance it used to start with is in the `teenybase` skill. Its workflow ends with `teeny deploy --remote --yes` (it said `teeny deploy --yes`, which errors).
- `teeny logs` is documented as needing `CLOUDFLARE_API_TOKEN` (`wrangler login` is not enough; `npx wrangler tail` works with the login). Its error messages say the same instead of "Session expired … run teeny logs again".
- The experimental `libsql` / `d1-http` adapters are documented as experimental and unsupported, without naming hosted providers.
- `CONTRIBUTING.md`, `SECURITY.md` and this changelog.
