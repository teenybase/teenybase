---
name: teenybase
description: >-
  Build, change and deploy a Teenybase backend on Cloudflare Workers + D1, defined in one
  teenybase.ts file: tables, fields, auth, access rules, actions, generated migrations, local dev
  and deploys. Use when a project has teenybase.ts or teeny.config.ts or imports 'teenybase', or
  when the user wants a backend, database, REST API or auth on Cloudflare and picks Teenybase.
  Covers the workflow, the config shape and the mistakes agents make most often.
license: Apache-2.0
---

# Teenybase

One `DatabaseSettings` object in `teenybase.ts` is the whole backend. The CLI generates SQL migrations from it, and the worker serves a REST API, auth, access rules, OpenAPI docs and an admin panel on Cloudflare Workers + D1.

Related skills: `teeny-rules` (writing access rules), `teeny-migrate` (migrations, deploys, fixing CLI errors).

## 1. Find out what is being built

If the user hasn't said, ask what they are building and what the backend has to do. They answer with intentions ("I need login", "a database for my recipes", "track Stripe subscribers"): infer the tables, auth and rules yourself instead of asking for a schema.

Work out whether it's a new project or an existing one (an existing `package.json`, or "add a backend to my app", means existing). If unclear, ask.

## 2. Workflow

```bash
npx teenybase create my-app --yes      # new project: with-auth template (users + auth + rules), runs npm install
# existing project: see "Option B" in docs/getting-started.md (npm install teenybase hono ..., then npx teenybase init --yes)

# edit teenybase.ts, then after EVERY change:
npx teenybase deploy --local --yes     # generate migrations from teenybase.ts + apply them to the local DB
npx teenybase dev                      # start once; it reloads after each deploy --local
```

Local API: `http://localhost:8787/api/v1`, Swagger UI `/api/v1/doc/ui`, OpenAPI JSON `/api/v1/doc`, admin panel `/api/v1/pocket/` (passwords `viewer` / `editor` from `.dev.vars`). `npx teenybase inspect --validate` checks the config without deploying.

Deploy when the user asks:

```bash
npx wrangler login                     # the user runs this once (opens a browser); or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
npx teenybase deploy --remote --yes    # creates the D1 database, generates + uploads secrets, applies migrations, deploys
npx teenybase deploy --temporary --yes # no Cloudflare account: temporary account, live URL + claim URL, 60 minutes
```

Give a `--temporary` claim URL to the user privately (it works like a password) and tell them to claim it within 60 minutes or Cloudflare deletes everything. Details and errors: `teeny-migrate` skill.

## 3. Config shape

Read the existing `teenybase.ts` before editing. A users table with auth plus one data table:

```typescript
import { DatabaseSettings, TableAuthExtensionData, TableRulesExtensionData, sqlValue } from 'teenybase'
import { baseFields, authFields, createdTrigger, updatedTrigger } from 'teenybase/scaffolds/fields'

export default {
    appUrl: 'http://localhost:8787',
    jwtSecret: '$JWT_SECRET',                       // $NAME reads .dev.vars locally, .prod.vars in production
    tables: [{
        name: 'users',
        autoSetUid: true,
        fields: [...baseFields, ...authFields],
        triggers: [createdTrigger, updatedTrigger],
        extensions: [
            { name: 'auth', jwtSecret: '$JWT_SECRET_USERS', jwtTokenDuration: 3600, maxTokenRefresh: 5,
              passwordConfirmSuffix: 'Confirm' } as TableAuthExtensionData,
            { name: 'rules', listRule: 'auth.uid == id', viewRule: 'auth.uid == id',
              createRule: 'true',                   // public sign-up goes through createRule
              updateRule: 'auth.uid == id', deleteRule: 'auth.uid == id' } as TableRulesExtensionData,
        ],
    }, {
        name: 'posts',
        autoSetUid: true,
        fields: [
            ...baseFields,
            { name: 'author_id', type: 'relation', sqlType: 'text', notNull: true, foreignKey: { table: 'users', column: 'id' } },
            { name: 'title', type: 'text', sqlType: 'text', notNull: true },
            { name: 'published', type: 'bool', sqlType: 'boolean', default: sqlValue(false) },
        ],
        triggers: [createdTrigger, updatedTrigger],
        extensions: [{ name: 'rules',
            listRule: 'published == true | auth.uid == author_id',
            viewRule: 'published == true | auth.uid == author_id',
            createRule: 'auth.uid != null & author_id == auth.uid',
            updateRule: 'auth.uid == author_id & new.author_id == author_id',
            deleteRule: 'auth.uid == author_id',
        } as TableRulesExtensionData],
    }],
} satisfies DatabaseSettings
```

Field types, sqlTypes, usages, indexes, FTS, triggers, email, OAuth, actions and `authCookie` (needed when the worker renders HTML for logged-in users): `docs/config-reference.md`.

## 4. Mistakes to avoid

- **`npx teenybase`, never `npx teeny`.** `teeny` on npm is an unrelated package. Inside a project with teenybase installed, `teeny` is also the CLI.
- **Use the CLI, not wrangler, for deploy, migrations, dev and secrets.** Run `wrangler` directly only for `login`, `whoami` and `tail`.
- **Never write or edit files in `migrations/`.** They are generated from `teenybase.ts` (and re-synced from the deployed database). Change `teenybase.ts` and run `deploy --local`.
- **Every table needs a `rules` extension or `public: true`.** Otherwise non-admin requests get 403 and `generate` / `deploy` / `build` fail with `Table "x" has no access rules.` An omitted rule is `null` = denied. `{ name: 'rules' }` alone = admin-only table. `public: true` = anyone can read AND write, and can't be combined with rules.
- **Rules are strings:** `listRule: 'true'`, not `true`. `==` is SQL `IS` (null-safe), `=` is SQL `=`.
- **`updateRule` sees the stored row.** Add `new.<col> == <col>` to stop a user changing a column (e.g. handing a post to someone else). Use `==`: with `=` a NULL column never matches.
- **In `createRule`, an omitted column reads as its `default` (or NULL).**
- **`role`, `email_verified` and `password_salt` are admin-only.** A non-admin request that sends them gets 403 (`role can only be set by an admin`). Give `role` a `default` if users need one; `auth.meta` is NOT protected this way.
- **Sign-up needs `passwordConfirm`** when the auth extension sets `passwordConfirmSuffix: 'Confirm'` (the with-auth template does): `POST /api/v1/table/users/auth/sign-up` with `{username, email, password, passwordConfirm, name}`. Returns `{token, refresh_token, record}`; send `Authorization: Bearer <token>`.
- **change-password needs `passwordCurrent`** (and `passwordConfirm` with `passwordConfirmSuffix`). Users created by OAuth/token sign-in have no password they know: they use password reset.
- **Code that runs on sign-in goes in the worker, not `teenybase.ts`** (the config is JSON): `db.onSignIn.push(async ({provider, user, created, external, db}) => {...})` in the `teenyHono` callback of `src/index.ts`; write with `db.rawSQL`, throw to refuse. See `config-reference.md` "Sign-in hook".
- **External JWT issuers (`authProviders` with `issuer`) need `clientId`**, and their tokens need `email` + `email_verified: true` claims (or `trustEmailVerified: true` on the issuer). The OAuth `redirect` must have `appUrl`'s exact origin unless listed in `allowedRedirectUrls`.
- **`/insert` wraps the row:** `{"values": {...}, "returning": "*"}`. A bare body is a 400; without `returning` the response is empty. `/update` uses `{"where", "setValues"}`; `/edit/:id` takes bare fields.
- **`default` / `check` strings are raw SQL.** `default: 'draft'` is not the text 'draft': use `sqlValue('draft')`.
- **Imports:** `baseFields`, `authFields` and the triggers come from `teenybase/scaffolds/fields`; keep `satisfies DatabaseSettings` for type checking.
- **Quote user input in `where` / filter expressions with `JSON.stringify`:** `` `email == ${JSON.stringify(email)}` ``. Values are bound as SQL parameters, but a raw `'${value}'` can close the quote and add `| ...` to the expression.
- **`usage` values are not validated.** A misspelt usage (`'auth_emial'`) is silently ignored; copy them from the docs.
- **Error details:** API errors hide the cause unless `RESPOND_WITH_ERRORS=true` is set, which belongs in `.dev.vars` only (the scaffold has it commented out). Never set it in `.prod.vars` or production vars.

## 5. Reference

The docs ship in the package, matching the installed version: `node_modules/teenybase/docs/<file>.md` (`npx teenybase docs` lists them; skills: `npx teenybase skills`). Online: https://teenybase.com/docs and https://teenybase.com/llms.txt.

| Need | File in `node_modules/teenybase/docs/` | Online |
|---|---|---|
| Setup, project files, deploy steps | `getting-started.md` | https://teenybase.com/docs/getting-started/quickstart |
| Every config option, rules syntax | `config-reference.md` | https://teenybase.com/docs/reference/config-reference |
| Request/response formats | `api-endpoints.md` | https://teenybase.com/docs/reference/api-endpoints |
| Frontend fetch code, auth flow | `frontend-guide.md` | https://teenybase.com/docs/guides/frontend |
| Server-side actions | `actions-guide.md` | https://teenybase.com/docs/reference/actions-guide |
| Copy-paste patterns | `recipes.md`, `recipe-full-app.md` | https://teenybase.com/docs/guides/recipes |
| OAuth providers | `oauth-guide.md` | https://teenybase.com/docs/guides/google-oauth-onetap |
| CLI commands and flags | `cli.md` | https://teenybase.com/docs/reference/cli |
| Error messages | `troubleshooting.md` | https://teenybase.com/docs/reference/troubleshooting |

Authoritative when docs and behaviour disagree: the types in `node_modules/teenybase/dist/types/` (JSDoc on config options) and the live OpenAPI spec at `/api/v1/doc`.
