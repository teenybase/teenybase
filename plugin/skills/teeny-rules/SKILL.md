---
name: teeny-rules
description: >-
  Write or review Teenybase access rules (listRule, viewRule, createRule, updateRule, deleteRule) in
  teenybase.ts: owner-only, public read, published-or-owner, admin-only and role-based patterns, and
  the expression syntax they compile to (parameterized SQL WHERE clauses). Use when adding a table,
  changing who can read or write rows, or debugging a 403 or a rule that lets too much through.
license: Apache-2.0
allowed-tools: Read Grep Glob
---

# Teenybase access rules

Each table gets a `rules` extension. Every rule is a string expression that compiles to a parameterized SQL `WHERE` clause; admins (admin JWT, `ADMIN_SERVICE_TOKEN`) skip rules.

```typescript
{ name: 'rules',
  listRule: '...',    // filters list/select
  viewRule: '...',    // filters view/:id
  createRule: '...',  // checks the row being inserted (also password sign-up on an auth table)
  updateRule: '...',  // filters which rows can be updated; new.* = the values being set
  deleteRule: '...',  // filters which rows can be deleted
} as TableRulesExtensionData
```

## Values and defaults

- `'true'` allows everyone, including logged-out requests. `'false'`, `null` or an omitted rule denies (403).
- A table with no `rules` extension denies every non-admin request, and `npx teenybase generate` / `deploy` / `build` fail with `Table "x" has no access rules.` Add rules, or `{ name: 'rules' }` for an admin-only table, or `public: true` on the table for full anonymous read AND write (not combinable with rules).
- Rules are strings: `'true'`, never `true`.

## Patterns

```typescript
// Users table (auth): own row only, open sign-up
listRule: 'auth.uid == id', viewRule: 'auth.uid == id', createRule: 'true',
updateRule: 'auth.uid == id', deleteRule: 'auth.uid == id',

// Published or owner; the author can't post as, or hand the row to, someone else
listRule: 'published == true | auth.uid == author_id',
viewRule: 'published == true | auth.uid == author_id',
createRule: 'auth.uid != null & author_id == auth.uid',
updateRule: 'auth.uid == author_id & new.author_id == author_id',
deleteRule: 'auth.uid == author_id',

// Public read, admin-only writes: set only these two
listRule: 'true', viewRule: 'true',

// Role-based
createRule: "auth.role == 'admin' | auth.role == 'editor'",
deleteRule: "auth.role == 'admin'",
```

## Syntax

- Variables: `auth.uid` (null when logged out), `auth.email`, `auth.role`, `auth.verified`, `auth.admin`, `auth.meta.<key>`, `auth.jwt.<claim>`, column names of the table, and `new.<col>` in createRule/updateRule.
- `==` is `IS` (null-safe), `!=` is `IS NOT`, `=` is SQL `=`; `<`, `>`, `<=`, `>=`; `~` / `!~` are `LIKE` / `NOT LIKE`; `&` is AND, `|` is OR (`&` binds tighter; use parentheses); `!x` is NOT; `@@` is FTS match; `->` / `->>` read JSON; `||` concatenates.
- Functions: `lower`, `upper`, `length`, `substring`, `replace`, `concat`, `date`, `datetime`, `time`, `unixepoch`, `json_contains(col, value)`, `json_set` and friends.
- Literals are bound as parameters and column names are checked against the table (no SQL injection). But a value pasted into an expression string can still change the expression: `` `email == '${v}'` `` with `v = "x' | email != '"` adds an OR. Quote user input with `JSON.stringify`: `` where: `email == ${JSON.stringify(email)}` ``.

## Traps

- **updateRule needs an "unchanged" check** for columns that must not change: `& new.author_id == author_id`. A column the update doesn't send reads as its stored value, so other edits still pass. Use `==`: `new.col = col` never matches when the column is NULL.
- **In createRule there is no stored row:** `author_id` and `new.author_id` both mean the inserted value, and a column the request omits reads as its `default` (or NULL). `createRule: "status == 'draft'"` passes when `status` is omitted and defaults to `'draft'`.
- **`!col` on a NULL column is NULL, so the row is filtered out.** Write `deleted_at == null`, not `!deleted_at`.
- **`role`, `email_verified`, `password_salt` are admin-only writes**, so `auth.role == 'admin'` is safe to rely on. `auth.meta` is not protected: if rules read it, add `& new.meta == meta` to the users updateRule and check `meta` in its createRule.
- **list/view rules filter, they don't fail:** a row the user can't see is simply missing from the result (view returns 404).
- **`or: 'REPLACE'`** on insert/update (and `/edit/:id?or=INSERT`) is 403 for non-admins unless `deleteRule` is `'true'`; never allowed on auth tables. For "create or update", insert with `or: 'IGNORE'` + a unique index, then update.

After editing rules: `npx teenybase deploy --local --yes`, then test as a logged-out user and as two different users.

Full reference (variables, operators, functions, more examples): "Rules Extension" in `node_modules/teenybase/docs/config-reference.md` (https://teenybase.com/docs/reference/config-reference), guide: https://teenybase.com/docs/guides/rls. Security model: `docs/security.md`.
