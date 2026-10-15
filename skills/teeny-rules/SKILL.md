---
name: teeny-rules
description: >-
  Write access rule expressions for Teenybase row-level security. Understands
  expression syntax (auth.uid, operators, variables), how rules compile to SQL
  WHERE clauses, and patterns like owner-only, admin-only, public read. Use when
  writing listRule, viewRule, createRule, updateRule, deleteRule.
allowed-tools: Read Grep
---

# Writing Access Rules for Teenybase

Rules provide row-level security by compiling JS-like expressions to SQL WHERE clauses.

## Rule Extension Structure

```typescript
import type { TableRulesExtensionData } from 'teenybase'

{
    name: 'rules',
    listRule: 'expression',    // filter for list/select queries
    viewRule: 'expression',    // filter for single record view
    createRule: 'expression',  // guard before insert
    updateRule: 'expression',  // guard + filter for updates
    deleteRule: 'expression',  // guard + filter for deletes
} as TableRulesExtensionData
```

## Rule Values

| Value | Behavior |
|-------|----------|
| `'true'` | Allow all requests, including unauthenticated |
| `'false'` | Deny all requests |
| `null` (or omitted) | Deny all requests — this is the default |
| Expression string | Evaluated per request |

**Important:** `null` = deny. Forgetting to set a rule defaults to denying all access.

## Tables Without Rules (default-deny)

- A table with **no `rules` extension** denies list/view/insert/update/delete to anonymous and signed-in users (403). Admin / `ADMIN_SERVICE_TOKEN` requests and actions that bypass rules still work.
- `teeny generate`, `teeny deploy` and `teeny build` **fail** with `Table "x" has no access rules.` until every table has either a `rules` extension or `public: true`.
- Fix: add a `rules` extension (use `{name: 'rules'}` with no rules for an admin-only table), or set `public: true` on the table to give everyone, including unauthenticated requests, full read AND write access.
- `public: true` cannot be combined with a `rules` extension (validation error). For "public read, restricted write", use rules: `listRule: 'true', viewRule: 'true'` plus stricter write rules.
- Upgrading from 0.0.x: rules-less tables used to be fully open. Add `public: true` only if that was really intended.

## Common Patterns

### Public read, authenticated write
```typescript
{
    name: 'rules',
    listRule: 'true',
    viewRule: 'true',
    createRule: 'auth.uid != null & author_id == auth.uid',             // can't post as someone else
    updateRule: 'auth.uid == author_id & new.author_id == author_id',   // can't hand the row to someone else
    deleteRule: 'auth.uid == author_id',
} as TableRulesExtensionData
```

### Owner-only (users table pattern)
```typescript
{
    name: 'rules',
    listRule: 'auth.uid == id',
    viewRule: 'auth.uid == id',
    createRule: 'true',            // needed for sign-up to work
    updateRule: 'auth.uid == id',
    deleteRule: 'auth.uid == id',
} as TableRulesExtensionData
```
The auth extension makes `role` (auth_audience), `email_verified` and `password_salt` admin-only on top of these rules: a user who sends them at sign-up or in an update gets 403 `"role can only be set by an admin"`. New users get the column `default` (set one on `role` if every user should start with a role); an admin token promotes a user with a normal `update`. That is what makes `auth.role == 'admin'` below safe. `auth.meta` is NOT protected this way: if rules read `auth.meta`, add `& new.meta == meta` to the users updateRule (and check `meta` in createRule).

### Admin-only
```typescript
{
    name: 'rules',
    listRule: "auth.role == 'admin'",
    viewRule: "auth.role == 'admin'",
    createRule: "auth.role == 'admin'",
    updateRule: "auth.role == 'admin'",
    deleteRule: "auth.role == 'admin'",
} as TableRulesExtensionData
```

### Published or owner
```typescript
{
    name: 'rules',
    listRule: "published == true | auth.uid == author_id",
    viewRule: "published == true | auth.uid == author_id",
    createRule: 'auth.uid != null & author_id == auth.uid',
    updateRule: 'auth.uid == author_id & new.author_id == author_id',
    deleteRule: 'auth.uid == author_id',
} as TableRulesExtensionData
```

### Role-based (admin or editor)
```typescript
{
    name: 'rules',
    listRule: 'true',
    viewRule: 'true',
    createRule: "auth.role == 'admin' | auth.role == 'editor'",
    updateRule: "auth.role == 'admin' | auth.role == 'editor'",
    deleteRule: "auth.role == 'admin'",
} as TableRulesExtensionData
```

### Status-based with owner override
```typescript
{
    name: 'rules',
    listRule: "status == 'published' | auth.uid == author_id",
    viewRule: "status == 'published' | auth.uid == author_id",
    createRule: 'auth.uid != null & author_id == auth.uid',
    updateRule: "auth.uid == author_id & status != 'locked' & new.author_id == author_id",
    deleteRule: 'auth.uid == author_id',
} as TableRulesExtensionData
```

### Fully public (read + write)
```typescript
{
    name: 'rules',
    listRule: 'true',
    viewRule: 'true',
    createRule: 'true',
    updateRule: 'true',
    deleteRule: 'true',
} as TableRulesExtensionData
```

## Common Mistakes

1. **`null` denies access.** Omitting a rule defaults to `null` (deny all). Always explicitly set rules you want accessible. A table with no `rules` extension at all is denied too, and the CLI refuses to deploy it (see above).

2. **String `'true'`, not boolean `true`.** Rule values must be strings:
   ```typescript
   listRule: 'true'    // ✅ correct
   listRule: true       // ❌ wrong
   ```

3. **In createRule, columns are the row being inserted.** There is no stored row yet, so `author_id` and `new.author_id` both mean the value being inserted. A column the request leaves out is its `default`, or NULL:
   ```typescript
   createRule: 'auth.uid != null'                              // ✅ check auth state
   createRule: 'auth.uid != null & new.author_id == auth.uid'  // ✅ check inserted values (same as author_id == auth.uid)
   createRule: "status == 'draft'"                             // ✅ passes when status is omitted and defaults to 'draft'
   ```

4. **updateRule only sees the old row unless you use `new.*`.** `updateRule: 'auth.uid == author_id'` lets the author set `author_id` to someone else. Add an "unchanged" check: `new.author_id == author_id`. A column the update doesn't touch reads as its stored value, so other edits still pass. Use `==` here, not `=` (with `=` a NULL column never equals itself).

5. **Null comparisons.** `auth.uid != null` = logged in. `auth.uid == null` = NOT logged in.

6. **`=` vs `==`.** `=` is SQL `=` (not null-safe), `==` is SQL `IS` (null-safe). Use `==` when comparing with `null` or when null values are possible.

7. **Quoting strings in expressions.** Use single quotes inside double-quoted strings:
   ```typescript
   listRule: "status == 'published'"     // ✅
   ```

8. **`!column` doesn't work for NULL columns.** In SQL, `NOT NULL` evaluates to NULL (falsy), not true. Use explicit null checks:
   ```typescript
   listRule: '!deleted_at'              // ❌ NOT NULL → NULL → row filtered out
   listRule: 'deleted_at == null'       // ✅ IS NULL → true when column is null
   ```

## Expression Syntax Reference

For all operators, variables, SQL functions, and variable scope details, read:
**`skills/teenybase/references/EXPRESSION_SYNTAX.md`**

Key variables: `auth.uid`, `auth.email`, `auth.role`, `auth.verified`, `new.*` (insert/update values), column names.
Key operators: `==`, `!=`, `>`, `<`, `~` (LIKE), `in`, `@@` (FTS), `&` (AND), `|` (OR).
