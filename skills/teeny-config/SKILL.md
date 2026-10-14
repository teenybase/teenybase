---
name: teeny-config
description: >-
  Create or modify teenybase.ts (or teeny.config.ts) for Teenybase. Helps define tables, fields,
  auth, rules, triggers, indexes, FTS, OAuth, email, and actions. Use when
  creating a new config, adding tables, modifying fields, or setting up auth.
allowed-tools: Read Grep Glob
---

# Creating and Modifying teenybase.ts

## Before You Start

1. **Always read the existing config file first** — check for `teenybase.ts` or `teeny.config.ts`
2. Check what tables, fields, and extensions are already defined
3. Read `docs/config-reference.md` for any option you're not sure about

## Minimal Config

```typescript
import { DatabaseSettings } from 'teenybase'
import type { TableAuthExtensionData, TableRulesExtensionData } from 'teenybase'
import { baseFields, authFields, createdTrigger, updatedTrigger } from 'teenybase/scaffolds/fields'
import { sql, sqlValue } from 'teenybase'

export default {
    appUrl: 'http://localhost:8787',     // required
    jwtSecret: '$JWT_SECRET',            // required — $ prefix resolves from env vars
    tables: [],
} satisfies DatabaseSettings
```

## Users Table + Data Table Pattern

This is the template most apps start with. Copy and adapt:

```typescript
tables: [
    {
        name: 'users',
        autoSetUid: true,
        fields: [...baseFields, ...authFields],
        triggers: [createdTrigger, updatedTrigger],
        extensions: [
            {
                name: 'auth',
                jwtSecret: '$JWT_SECRET_USERS',  // required
                jwtTokenDuration: 3600,           // required (seconds)
                maxTokenRefresh: 5,               // required
            } as TableAuthExtensionData,
            {
                name: 'rules',
                listRule: 'auth.uid == id',
                viewRule: 'auth.uid == id',
                createRule: 'true',       // needed for sign-up to work
                updateRule: 'auth.uid == id',
                deleteRule: 'auth.uid == id',
            } as TableRulesExtensionData,
        ],
    },
    {
        name: 'posts',
        autoSetUid: true,
        fields: [
            ...baseFields,
            { name: 'author_id', type: 'relation', sqlType: 'text', notNull: true,
              foreignKey: { table: 'users', column: 'id' } },
            { name: 'title', type: 'text', sqlType: 'text', notNull: true },
            { name: 'body', type: 'editor', sqlType: 'text' },
            { name: 'published', type: 'bool', sqlType: 'boolean', default: sqlValue(false) },
        ],
        triggers: [createdTrigger, updatedTrigger],
        extensions: [{
            name: 'rules',
            listRule: "published == true | auth.uid == author_id",
            viewRule: "published == true | auth.uid == author_id",
            createRule: 'auth.uid != null',
            updateRule: 'auth.uid == author_id',
            deleteRule: 'auth.uid == author_id',
        } as TableRulesExtensionData],
    },
],
```

## Common Field Patterns

### Foreign key / relation
```typescript
{ name: 'author_id', type: 'relation', sqlType: 'text', notNull: true,
  foreignKey: { table: 'users', column: 'id' } }
```

### JSON field
```typescript
{ name: 'config', type: 'json', sqlType: 'json',
  check: sql`json_valid(config)` }
```

### Enum / select field
```typescript
{ name: 'status', type: 'select', sqlType: 'text', notNull: true,
  default: sqlValue('draft'),
  check: sql`status IN ('draft', 'published', 'archived')` }
```

### File upload field
```typescript
{ name: 'attachment', type: 'file', sqlType: 'text' }
// Also set r2Base on the table: r2Base: 'posts'
```

### Boolean with default
```typescript
{ name: 'active', type: 'bool', sqlType: 'boolean', default: sqlValue(true), notNull: true }
```

### URL / email fields
```typescript
{ name: 'website', type: 'url', sqlType: 'text' }
{ name: 'contact', type: 'email', sqlType: 'text' }
```

## Common Mistakes

1. **Boolean `true` vs string `'true'` in rules.** Rules must be strings: `listRule: 'true'`, not `listRule: true`.
2. **Forgetting `satisfies DatabaseSettings`.** Without it, you lose type checking.
3. **Missing scaffold import.** `baseFields` and `authFields` come from `teenybase/scaffolds/fields`, not `teenybase`.
4. **Wrong field usage values.** Usage values are specific strings like `'record_uid'`, `'auth_email'`. Typos silently fail.
5. **Using `default: 'some text'` instead of `default: sqlValue('some text')`.** Plain strings are treated as SQL expressions, not literal values.
6. **Forgetting `r2Base` on tables with file fields.** If any field has `type: 'file'`, the table needs `r2Base: 'some-prefix'`.
7. **Not casting extensions.** Use `as TableAuthExtensionData` and `as TableRulesExtensionData` for type safety.
8. **Missing required auth fields.** `jwtSecret`, `jwtTokenDuration`, and `maxTokenRefresh` are all required on the auth extension. Omitting them fails validation at runtime.
9. **Users table createRule is null.** Sign-up creates a row via the rules extension. If `createRule` is `null` (the default), sign-up returns 403. Use `createRule: 'true'` for public sign-up.
10. **Table without a rules extension.** Every table needs a `rules` extension or `public: true`. Without either, non-admin CRUD on it returns 403 and `teeny generate` / `deploy` / `build` fail with `Table "x" has no access rules.`. `public: true` opens full anonymous read AND write and cannot be combined with rules; use `extensions: [{ name: 'rules' }]` for an admin-only table.
11. **SSR frontend without authCookie.** If your `src/index.ts` serves HTML (SSR), add `authCookie` to your config. Without it, the server can't read the auth token — pages always render as "logged out." After login, set the cookie with `setCookie(c, 'auth_token', token, ...)`.

## After Editing Config

```bash
teeny deploy --local --yes     # generate + apply migrations
# A running `teeny dev` reloads with the new config automatically
```

## Where to Look for More

- **All config options:** `docs/config-reference.md`
- **Field type → sqlType compatibility:** `skills/teenybase/references/CONFIG_QUICK_REF.md`
- **Rules and expressions:** use the `teeny-rules` skill, or read `skills/teenybase/references/EXPRESSION_SYNTAX.md`
- **OAuth setup:** `docs/oauth-guide.md`
- **Actions (server-side logic):** `docs/actions-guide.md`
- **Email config:** `docs/config-reference.md` (search "EmailSettings")
- **Indexes, FTS, triggers:** `docs/config-reference.md` (search each term)
- **Authoritative defaults (JSDoc):** `src/types/tableExtensions.ts`, `src/types/config.ts`
- **Complete working example:** `docs/recipe-full-app.md`
