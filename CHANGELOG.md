# Changelog

All notable changes to the `teenybase` npm package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semver](https://semver.org/) with the usual 0.x caveat that minor versions may break the API.

## Unreleased

Release 0.1.0. The last version on npm is 0.0.14; 0.0.15 and 0.0.16 were never published to npm (0.0.16 was the version on GitHub `main`), so upgrading from npm 0.0.14 also brings everything that was on that `main`. The entries below are the changes since that 0.0.16 tree.

### Breaking

- Auth `emailTemplates.verification.tags` / `emailTemplates.passwordReset.tags` are a `string[]`, like `email.tags`. They were typed and validated as a string, which was then spread into one tag per character (`'verification'` became `v`, `e`, `r`, ...); a string is now a validation error, so change `tags: 'x'` to `tags: ['x']`.
- **Tables with no `rules` extension now deny access by default.** List, view, insert, update and delete on such a table return 403 for anonymous and signed-in users; admin and service-token requests still work. `teeny generate`, `deploy` and `build` exit 1 naming each such table. Fix: add a `rules` extension, or set `public: true` on the table to keep the old open behaviour (`public: true` together with a `rules` extension is a validation error). See "Access Control Defaults" in [config-reference.md](docs/config-reference.md).
- **`RESPOND_WITH_ERRORS` is off unless set to `true`.** Error responses no longer include the generated SQL or its bound values; new scaffolds set it to `"false"` in `wrangler.jsonc`. For local debugging set `RESPOND_WITH_ERRORS=true` in `.dev.vars`.
- Non-admin `or: 'REPLACE'` (on `/insert`, `/update`, `/edit/:id?or=INSERT` and action steps that apply table rules) returns 403 unless the table's `deleteRule` is `'true'`, the table is not an auth table and no trigger runs on that event. Use `or: 'IGNORE'` plus an update for upserts.
- **The role/audience column, `email_verified` and `password_salt` of an auth table are admin-only.** A non-admin sign-up, `insert`, `update`, `edit` or action step (with table rules applied) that sets one returns 403 with a field error (`"role can only be set by an admin"`), whatever the rules and `noInsert`/`noUpdate` allow. `email_verified` at sign-up used to return 400 `"email_verified must not be set"`. New users get the column default (give `role` a `default`), admin tokens can still set them, and so can `applyTableRules: false` action steps. Users with role `admin` are not admin tokens: to let them change roles, use a guarded `applyTableRules: false` action (example in [recipe-full-app.md](docs/recipe-full-app.md)). See "Privileged auth fields" in [security.md](docs/security.md).
- A non-admin email change (only when the email column is not `noUpdate`) is validated like sign-up and resets `email_verified` unless the address is unchanged.
- Column names in a `createRule` resolve to the row being inserted, and a column the request leaves out reads as its default (or NULL). Rules like `role == 'guest'` or `new.status == null` used to fail every insert that omitted the column with `no such column: new.<col>` (400). In `updateRule`, an omitted `new.<col>` is the stored value, as before (now tested and documented).

### Security

- Error responses never echo SQL, password hashes or salts: password, salt and `noSelect` values are redacted at bind time, and the debug query data is returned only when both `RESPOND_WITH_ERRORS` and `RESPOND_WITH_QUERY_LOG` are on.
- `change-password` writes only the password and salt. It used to pass the whole request body to the update, so a signed-in user could also change their own `role`, `email` and other fields.
- `OR REPLACE` could delete another user's row through a unique-key conflict without checking `deleteRule`/`updateRule`; now restricted as described under Breaking.
- security.md no longer lists an OAuth open redirect: the callback already validates the `redirect` target against `allowedRedirectUrls` or `appUrl`'s hostname. Now covered by tests, and the remaining hostname-vs-origin nuance is documented.
- AES-GCM (`aesGcmEncrypt`, encrypted env secrets) uses a random 96-bit IV instead of 40-bit. `aesGcmDecrypt` without an explicit `ivLen` still reads values written with the old 5-byte IV (it tries 12 then 5; the GCM tag rejects the wrong split). A value encrypted with the new default can't be read by an older teenybase, so upgrade readers before writers.
- Password hashes and salts are never returned by a select or `returning`, or usable in a where/rule, for any caller. The Pocket UI `viewer` and `editor` logins are admin tokens, and admins used to get every `noSelect` column, so a viewer could read every user's password hash and salt through the REST API (`/table/users/select?select=*`). Other `noSelect` columns are still visible to admins.
- Anyone could sign up with `"role": "admin"`, or update their own row to it, and pass `auth.role == 'admin'` rules (the docs' admin-only pattern), because the scaffold's `role` column was writable under `createRule: 'true'` / `updateRule: 'auth.uid == id'`. Fixed by making it admin-only (see Breaking). Apps that ran an earlier version should check existing users for roles they did not grant.
- OAuth: a provider's email is no longer treated as verified when its userinfo response has no verification field. New per-provider option `trustEmailVerified` (default `false`); the built-in Google and LinkedIn presets set it. This closes a pre-account-takeover path through providers that don't verify email.
- The admin panel loads an exact `@teenybase/pocket-ui` version (0.0.5, `POCKET_UI_VERSION`) instead of `@latest`, so a new publish of that package can't change what runs in admin sessions. Swagger UI loads `swagger-ui-dist` 5.33.2 instead of the latest, and the admin login page's Pico CSS is pinned to 2.1.1 with Subresource Integrity.

### Added

- Cloudflare Email Service as an email provider (`email.cloudflare`, uses a Workers `send_email` binding). It is used only when Mailgun and Resend are not configured.
- Plain-text versions of the built-in email templates, sent alongside the HTML.
- `database` config field and experimental storage adapters (`d1-rest`, `libsql`, `d1-http`) plus an R2 REST adapter. Only `d1-binding` (the default) is supported by the CLI and migrations; see [config-reference.md](docs/config-reference.md#database).
- `db.registerExtension()`, `$Table.findExtension()`, and more exports from `teenybase/worker` (`MigrationHelper`, `$DatabaseRawImpl`, route types).
- `TEENYBASE_VERSION` export.
- The npm package now ships `docs/`, the agent skills (`skills/teenybase`, `teeny-rules`, `teeny-migrate`) and the Claude Code plugin manifest, so `teeny docs` and `teeny skills` work from an install.
- Package metadata: description, keywords, repository and bug links.
- `deploy --remote` with only `npx wrangler login`: the account comes from `account_id`, then `CLOUDFLARE_ACCOUNT_ID`, then the login (saved to `wrangler.jsonc`); the D1 database is created for `"database_id": "TEENY_AUTO_CREATE"` (the scaffold default) and missing secrets are generated into `.prod.vars`. The first deploy uploads secrets together with the worker (`wrangler deploy --secrets-file`, wrangler 4.74+) and retries the first admin API calls on 401/403/404, fixing the first-deploy migration 403.
- `--temporary` (deploy, generate, secrets, backup): deploy to a Cloudflare temporary account with no login; prints the live URL, the claim URL and the expiry (60 minutes). Needs wrangler 4.102+; refuses R2, routes and other bindings temporary accounts don't support.
- `teeny dev` reloads the worker when `deploy --local` applies new migrations; no restart needed.
- Scaffolds write `AGENTS.md` for coding agents (commands, the common mistakes, where the docs and skills are) and a one-line `CLAUDE.md` (`@AGENTS.md`). `init` in an existing project appends a marked teenybase section to `AGENTS.md` once and never changes an existing `CLAUDE.md` (it prints how to import `AGENTS.md`). Scaffolds no longer write `.claude/settings.json` or `.claude/rules/`; earlier scaffolds wrote Claude Code settings with undocumented `plugins`/`rules` keys and a rule that forbade the `npx wrangler login` the deploy docs start with.
- `create` / `init --no-install`. Scaffolds pin `teenybase` to the exact CLI version that generated them and use `@cloudflare/workers-types` ^5.

### Removed

- Removed the hosted-platform commands (`register`, `login`, `logout`, `whoami`, `list`, `status`, `delete`) and the Teenybase Cloud deploy choice; deploys go to your own Cloudflare account only (or a `--temporary` one). Use `npx wrangler whoami` to check your Cloudflare login, and `npx wrangler delete` / `npx wrangler d1 delete` to remove a deployed worker or database.

### Changed

- Requires Node.js 22 or newer (`engines.node` `>=22`, was `>=18.14.1`). New projects install the latest wrangler 4, which refuses to start on older Node. Commands that run wrangler now stop at once with a message naming the Node version.
- `$Database` no longer requires an adapter argument; it falls back to the configured `database` (default: the `PRIMARY_DB` D1 binding).
- File-name normalisation uses a Unicode-aware snake_case conversion.
- `dist/` is cleaned before every build, so packed tarballs contain no stale files.
- `teeny skills` prints the first sentence of each skill's `description` instead of its first heading.

### Fixed

- OAuth callback: a provider token/userinfo endpoint that can't be reached or answers with a non-JSON body (an HTML error page) returns 502 `OAuth provider token request failed` / `... response is not JSON (HTTP 500)` instead of a 500 with the raw error.
- A multi-row insert whose rows set different fields returns 400 naming the row and field (`Every row in values must set the same fields: row 2 is missing published_at...`) instead of 500. Rows that set the same fields in a different order now insert instead of failing with 500.
- `request-verification` and `request-password-reset` without an email provider return 501 `Email not configured: add an email provider...` instead of 500, and password reset answers the same whether or not the account exists.

- Duplicate sign-up returns a field-level error regardless of debug flags: `{"code":400,"message":"An account with this email already exists","data":{"email":{"_errors":[...]}}}` (same for username).
- D1 errors from current workerd: the extended result code is parsed into `extendedCode` instead of producing `code: "SQLITE_CONSTRAINT_UNIQUE)"`; composite unique indexes report every column. This also revives the OAuth username-collision retry.
- `/update` with `or` built `UPDATE t OR x SET` (a syntax error); it now builds `UPDATE OR x t SET`.
- CLI: every failure exits non-zero, including a failed `npm install` in `create`/`init` and a failed final `wrangler deploy`. Without a terminal, a command that needs an answer fails at once and names the flag (usually `--yes`).
- CLI: `deploy --local` writes `.local-persist/config.json` only after the migrations are applied, and sets up the database through the worker API directly instead of retrying a direct-D1 path that could not run batches.
- CLI: `deploy` and `generate` no longer delete `migrations/` files that git tracks when the target database has nothing applied yet (no `.local-persist/`, a new or empty D1). They used to regenerate the whole folder from the config with different names (e.g. after cloning a repository that commits `migrations/`), deleting the committed files; now they exit 1 before changing anything and say what to do. Untracked folders (the scaffold gitignores `migrations/`) are regenerated as before. Applying committed migrations to an empty database is planned for 0.1.1.
- CLI: `teeny dev` stops wrangler (and its workerd) when only its own pid gets SIGINT or SIGTERM (a process manager, `kill <pid>`, an IDE stop button) and exits after wrangler has. It used to exit at once and leave wrangler running on the port, because loading wrangler in-process for `deploy --local` installed signal handlers that exit immediately; wrangler is now loaded only when that local worker starts.
- CLI: runs wrangler as `node <wrangler bin>` without a shell, fixing `spawn npx ENOENT` on Windows. Thanks to @izulwahidin for reporting it (#1) and for the first fix (PR #3).
- `zod`, `esbuild`, `miniflare` and `undici` are declared dependencies; `@cloudflare/workers-types` ^5 is accepted.
- Applying migrations no longer fails when only the stored `sql_revert` differs from the local file.
- A migration that adds a column whose `check` names that column (`check: 'flag IN (0, 1)'`) no longer fails with `no such column: flag`. The column is added under its final name; when that name is still taken by a column renamed in the same migration, the table is rebuilt instead.
- Batched queries (`list`, `insert`, `update`, transactions) through a storage adapter that is a Workers RPC stub failed with `Could not serialize object of type "PreparedQuery"`. `runBatch` now receives plain `{q, v}` objects with plain arrays.
- File fields with a bucket that is a Workers RPC stub (such as `R2RestRPC`): uploads failed with `Could not serialize object of type "File"` and now stream through a new `putStream(key, stream, size, options)` on `R2RestAdapter`/`R2RestRPC` (no 32 MiB RPC limit; a native R2 binding still receives the File directly). `R2RestAdapter.delete` and `R2RestRPC.delete` accept an array of keys like `R2Bucket.delete`. A failed cleanup delete after a failed insert or update no longer replaces the original error with `Failed to delete files`. `/api/v1/files/...` builds its headers from `httpMetadata`, so files served through an RPC bucket keep their content type.
- Filters, rules and other expressions accept non-Latin text in string literals (`name == '文件（一）.glb'`, Gujarati, Arabic, accented Latin, emoji). They used to return 400 `Invalid expression` for anything outside ASCII. Control and format characters are still rejected, and column names stay ASCII.
- Wrangler warnings on stderr no longer break the CLI's parsing of wrangler's JSON output.
- Broken documentation links (self-hosting anchor, JWT library link).

### Docs

- Docs and skills describe deploying to your own Cloudflare account only.
- Agent skills slimmed to three: `teenybase` (workflow, config shape, the common mistakes; absorbs `teeny-config`), `teeny-rules` and `teeny-migrate`. The copied reference files (`skills/teenybase/references/`) are gone; skills point to the docs shipped in the package (`node_modules/teenybase/docs/`) and on teenybase.com. Frontmatter uses only Agent Skills standard fields. Content the old skills had that the docs lacked is now in config-reference.md (JSON and arithmetic operators, operator precedence, `!column` on NULL, raw-SQL string defaults, unvalidated `usage` names). Removed claims that weren't true: a missing `r2Base` breaking file fields, `in (...)` lists in rules, and an insert without `values` "silently failing" (it is a 400).
- Getting Started opens for a human reader; the agent guidance it used to start with is in the `teenybase` skill. Its workflow ends with `teeny deploy --remote --yes` (it said `teeny deploy --yes`, which errors).
- `teeny logs` is documented as needing `CLOUDFLARE_API_TOKEN` (`wrangler login` is not enough; `npx wrangler tail` works with the login). Its error messages say the same instead of "Session expired … run teeny logs again".
- The experimental `libsql` / `d1-http` adapters are documented as experimental and unsupported, without naming hosted providers.
- `CONTRIBUTING.md`, `SECURITY.md` and this changelog.
