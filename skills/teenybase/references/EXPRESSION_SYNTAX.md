# Teenybase Expression Syntax Reference

Expressions are used in **rules** (row-level security) and **action steps** (guards, where clauses). They compile to parameterized SQL WHERE clauses.

## Variables

### Auth variables (rules + steps)

These come from the authenticated user's JWT. See `docs/config-reference.md` (JWT Claims section) for the full claim-to-field mapping.

| Variable | Type | Description |
|----------|------|-------------|
| `auth.uid` | string\|null | User's record ID (JWT `id` claim). `null` if not logged in. |
| `auth.email` | string\|null | User's email (JWT `sub` claim). |
| `auth.role` | string\|null | User's role (JWT `aud` claim, from `auth_audience` field). |
| `auth.verified` | boolean | Email verified (JWT `verified` claim). |
| `auth.admin` | boolean | Whether user is admin (from JWT or service token). |
| `auth.superadmin` | boolean | Whether user is superadmin (service token only). |
| `auth.meta` | object | User metadata (JWT `meta` claim, from `auth_metadata` field). |
| `auth.jwt` | object | Raw JWT payload — access any claim via `auth.jwt.user`, `auth.jwt.sid`, etc. |

### Column variables (rules + steps)

| Variable | Available in | Description |
|----------|-------------|-------------|
| Column names | All rules except createRule | Any column from the current table (e.g., `owner_id`, `published`, `status`). |
| `new.*` | createRule, updateRule | The **new values being inserted/updated**. E.g., `new.status`, `new.author_id`. In createRule, these are the values from the INSERT. In updateRule, these are the SET values. |

### Steps-only variables

| Variable | Description |
|----------|-------------|
| `params.*` | Action parameters (e.g., `params.amount`, `params.id`). |
| `request.*` | Request context (e.g., headers, method). |

### Variable scope

| Variable | listRule | viewRule | createRule | updateRule | deleteRule | Action steps |
|----------|----------|----------|------------|------------|------------|-------------|
| `auth.*` | Yes | Yes | Yes | Yes | Yes | Yes |
| Column names | Yes | Yes | **No** (row doesn't exist yet) | Yes | Yes | Yes |
| `new.*` | No | No | Yes (inserted values) | Yes (SET values) | No | No |
| `params.*` | No | No | No | No | No | Yes |
| `request.*` | No | No | No | No | No | Yes |

## Operators

| Operator | SQL | Example | Notes |
|----------|-----|---------|-------|
| `==` | `IS` | `auth.uid == id` | NULL-safe equality. `== null` compiles to `IS NULL`. |
| `=` | `=` | `auth.uid = id` | Standard SQL `=` (not NULL-safe). Prefer `==`. |
| `!=` | `IS NOT` | `auth.uid != null` | NULL-safe inequality. `!= null` compiles to `IS NOT NULL`. |
| `>` | `>` | `price > 0` | |
| `<` | `<` | `age < 18` | |
| `>=` | `>=` | `priority >= 5` | |
| `<=` | `<=` | `count <= 100` | |
| `~` | `LIKE` | `email ~ '%@example.com'` | Pattern match. `%` = any chars, `_` = one char. |
| `!~` | `NOT LIKE` | `name !~ '%test%'` | Negated pattern match. |
| `in` | `IN` | `status in ('a','b')` | Membership test. |
| `@@` | `MATCH` | `title @@ 'search term'` | FTS5 full-text search match. |
| `->` | `->` | `data -> 'key'` | JSON extract (returns JSON). |
| `->>` | `->>` | `data ->> 'key'` | JSON extract (returns text). |
| `\|\|` | `\|\|` | `first \|\| ' ' \|\| last` | String concatenation. |
| `!` | `NOT` | `!published` | Unary negation. |
| `as` / `=>` | `AS` | `name as alias` | Column aliasing (SELECT only, not in rules). |
| `&` | `AND` | `a == 1 & b == 2` | Logical AND. |
| `\|` | `OR` | `a == 1 \| b == 2` | Logical OR. |

## Operator Precedence

1. Comparison operators (`==`, `!=`, `>`, `<`, `>=`, `<=`, `~`) — highest
2. `&` (AND)
3. `|` (OR) — lowest

Use parentheses to override: `(a == 1 | b == 2) & c == 3`

## SQL Functions

These functions can be used in expressions (rules, steps, select, where, order):

### String functions

| Function | SQL | Example |
|----------|-----|---------|
| `lower(x)` | `LOWER(x)` | `lower(email) == 'admin@test.com'` |
| `upper(x)` | `UPPER(x)` | `upper(status) == 'ACTIVE'` |
| `length(x)` | `LENGTH(x)` | `length(name) > 3` |
| `substring(x, start, len)` | `SUBSTRING(x, start, len)` | `substring(code, 1, 2) == 'US'` |
| `replace(x, from, to)` | `REPLACE(x, from, to)` | `replace(name, ' ', '-')` |
| `concat(a, b, ...)` | `CONCAT(a, b, ...)` | `concat(first, ' ', last)` |

### Aggregate functions (SELECT/steps only)

| Function | SQL | Example |
|----------|-----|---------|
| `count(x)` | `COUNT(x)` | `count(*)` or `count(id)` |
| `sum(x)` | `SUM(x)` | `sum(amount)` |

### Date/time functions

| Function | SQL | Example |
|----------|-----|---------|
| `datetime(x)` | `DATETIME(x)` | `datetime(created, '+1 hour')` |
| `date(x)` | `DATE(x)` | `date(created) == date('now')` |
| `time(x)` | `TIME(x)` | `time(created)` |
| `unixepoch(x)` | `UNIXEPOCH(x)` | `unixepoch('now') - unixepoch(created) < 3600` |

### JSON functions

| Function | SQL | Example |
|----------|-----|---------|
| `json_set(json, path, val)` | `JSON_SET(...)` | `json_set(meta, '$.key', 'value')` |
| `json_insert(json, path, val)` | `JSON_INSERT(...)` | Like json_set but doesn't overwrite |
| `json_replace(json, path, val)` | `JSON_REPLACE(...)` | Only replaces existing keys |
| `json_patch(json, patch)` | `JSON_PATCH(...)` | [RFC 7396](https://datatracker.ietf.org/doc/html/rfc7396) merge patch |
| `json_contains(json, val)` | `EXISTS(SELECT 1 FROM json_each(...))` | `json_contains(tags, 'important')` |

## Examples

Simple:
```
auth.uid != null                         → WHERE auth_uid IS NOT NULL
auth.uid == id                           → WHERE ? IS id  (parameterized)
```

Multiple conditions:
```
auth.uid == owner_id & status == 'active'
→ WHERE ? IS owner_id AND status IS ?
```

OR conditions:
```
published == true | auth.uid == author_id
→ WHERE published IS ? OR ? IS author_id
```

Using new.* in createRule:
```
auth.uid != null & new.author_id == auth.uid
→ Guard: checks that the inserted author_id matches the authenticated user
```

Using functions:
```
lower(email) ~ '%@example.com' & length(name) > 2
→ WHERE LOWER(email) LIKE ? AND LENGTH(name) > ?
```

## How Expressions Compile (Security Model)

Expressions are **not raw SQL** — they go through a full parse → validate → parameterize pipeline. This is the ORM-equivalent query pattern for teenybase.

A rule expression like `auth.uid == owner_id & published == true`:

1. Parsed by jsep (JS expression parser) into an AST
2. Column names validated against the table's field list (unknown columns rejected)
3. `auth.*` values resolved from JWT payload → become `?` parameters
4. String/number/boolean literals → become `?` parameters
5. Operators mapped to SQL equivalents (`==` → `IS`, `&` → `AND`, etc.)
6. Result: parameterized SQL `WHERE ? IS owner_id AND published IS ?` with bound values

**This means string interpolation in expressions is safe:**
```typescript
// This is the CORRECT pattern — NOT SQL injection
await table.select({ where: `email == '${userEmail}'` })
// Compiles to: WHERE email IS ?  with value: [userEmail]

// Equivalent to an ORM call like:
// db.users.findMany({ where: { email: userEmail } })
```

The expression parser handles all parameterization. You never write raw SQL in expressions.

## Common Mistakes

1. **`null` denies access.** Omitting a rule = `null` = deny all. Set `'true'` for public access. A table with no `rules` extension is denied entirely (unless it sets `public: true`), and the CLI refuses to deploy it.
2. **String `'true'`, not boolean.** `listRule: 'true'` (string) works. `listRule: true` (boolean) does NOT.
3. **Create rules can't reference existing row data.** The row doesn't exist yet. Use `auth.*` and `new.*` only.
4. **Null comparison.** `auth.uid == null` checks if NOT logged in. `auth.uid != null` checks if logged in.
5. **No nested subqueries.** Expressions are flat — no `SELECT` inside a rule expression.
6. **`=` vs `==`.** `=` is SQL `=` (not null-safe), `==` is SQL `IS` (null-safe). Use `==` when comparing with `null` or when null values are possible. `auth.uid == null` works, `auth.uid = null` does not.
7. **`!column` doesn't work for NULL.** SQL `NOT NULL` evaluates to NULL (falsy), not true. Use `column == null` instead of `!column` for nullable columns. Example: `deleted_at == null` not `!deleted_at`.
