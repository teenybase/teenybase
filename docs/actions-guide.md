# Actions Guide

> Server-side logic with typed parameters, callable via API.

Actions let you run server-side SQL or multi-step logic through a simple API call. They're defined in your `teenybase.ts` and available at `POST /api/v1/action/{name}`.

Two modes:
- **SQL mode** — raw query objects with parameterized SQL. Full control, bypasses table rules.
- **Steps mode** — expression-based statements that go through the table layer. Can apply RLS rules.

---

## Quick Example

```typescript
// teenybase.ts
import { DatabaseSettings, sql, sqlValue } from 'teenybase'

export default {
    // ... tables, jwtSecret, etc.
    actions: [
        {
            name: 'increment_counter',
            params: { amount: 'number' },
            requireAuth: true,
            sql: {
                type: 'UPDATE',
                table: 'counters',
                set: { value: 'value + {:amount}' },
                where: sql`id = 1`,
                returning: ['*'],
            },
        },
    ],
} satisfies DatabaseSettings
```

Call it:

```bash
curl -X POST http://localhost:8787/api/v1/action/increment_counter \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{ "amount": 5 }'
```

Response:

```json
[[{ "id": 1, "value": 15 }]]
```

---

## SQL Mode

SQL mode gives you raw query objects with full control over the SQL. Queries bypass table rules entirely — use `guard` or `requireAuth` for access control.

### Single Query

```typescript
{
    name: 'get_active_users',
    params: { role: 'string' },
    sql: {
        type: 'SELECT',
        table: 'users',
        where: sql`role = {:role} AND email_verified = true`,
    },
}
```

### Multiple Queries (Transaction)

Pass an array — all queries execute in a single D1 batch (transaction).

```typescript
{
    name: 'transfer_credits',
    params: { from_id: 'string', to_id: 'string', amount: 'integer' },
    requireAuth: true,
    sql: [
        {
            type: 'UPDATE',
            table: 'accounts',
            set: { credits: 'credits - {:amount}' },
            where: sql`id = {:from_id} AND credits >= {:amount}`,
        },
        {
            type: 'UPDATE',
            table: 'accounts',
            set: { credits: 'credits + {:amount}' },
            where: sql`id = {:to_id}`,
        },
    ],
}
```

### Query Object Properties

Each query object has a `type` that determines the available properties:

#### SELECT

```typescript
{
    type: 'SELECT',
    table: 'posts',
    where: sql`published = true AND category = {:category}`,
    // Optional:
    selects: ['id', 'title', 'created'],  // Fields to return (default: all)
    limit: 10,
    offset: 0,
    orderBy: 'created DESC',
    distinct: true,
    groupBy: ['category'],
}
```

#### UPDATE

```typescript
{
    type: 'UPDATE',
    table: 'posts',
    set: { view_count: sql`view_count + 1` },       // SQL expressions (values must be sql`` or sqlValue())
    where: sql`id = {:post_id}`,
    returning: ['*'],                               // Return updated rows
    // Optional:
    or: 'IGNORE',                                   // Conflict strategy
}
```

#### INSERT

```typescript
{
    type: 'INSERT',
    table: 'audit_log',
    values: { user_id: sql`{:user_id}`, action: sql`{:action}`, timestamp: sql`CURRENT_TIMESTAMP` },
    returning: ['id'],
    // Optional:
    or: 'IGNORE',                                   // Conflict strategy: ABORT|FAIL|IGNORE|REPLACE|ROLLBACK
}
```

#### DELETE

```typescript
{
    type: 'DELETE',
    table: 'sessions',
    where: sql`user_id = {:user_id} AND expired = true`,
    returning: ['id'],
}
```

### Parameter Substitution

In SQL mode, parameters from the request body are merged into the query. Use `{:paramName}` syntax inside `sql` tagged templates:

```typescript
where: sql`email = {:email} AND id = {:id}`
```

This generates parameterized SQL (`email = ? AND id = ?`) — safe from SQL injection.

In `set` expressions (for UPDATE), parameters are also available:

```typescript
set: { credits: 'credits + {:amount}' }
```

---

## Steps Mode

Steps mode uses expression-based statements that go through the table layer. This means:
- Table rules (RLS) can be applied (controlled by `applyTableRules`)
- Expressions use the same syntax as [rule expressions](config-reference.md#expression-syntax)
- Auth context (`auth.*`) and params (`params.*`) are available in expressions

### Single Step

```typescript
{
    name: 'archive_my_drafts',
    requireAuth: true,
    params: { before: 'string' },
    steps: {
        type: 'UPDATE',
        table: 'posts',
        setValues: { status: 'archived' },
        where: "author_id = auth.uid & status = 'draft' & created < params.before",
    },
}
```

Steps run with the caller's privileges (unless `applyTableRules: false`), so they cannot write the admin-only auth columns (`role`/audience, `email_verified`, `password_salt`): a step that sets one gets `403`. See [Security: Privileged auth fields](security.md#privileged-auth-fields).

### Multiple Steps

Pass an array — steps execute sequentially in a single transaction.

```typescript
{
    name: 'archive_and_notify',
    requireAuth: true,
    params: { post_id: 'string' },
    steps: [
        {
            type: 'UPDATE',
            table: 'posts',
            setValues: { status: 'archived' },
            where: "id = params.post_id & author_id = auth.uid",
        },
        {
            type: 'INSERT',
            table: 'notifications',
            expr: { user_id: 'auth.uid', message: "'Post archived'" },
        },
    ],
}
```

### Expression Syntax in Steps

Steps use the same expression language as table rules:

| Variable | Description |
|----------|-------------|
| `auth.uid` | Authenticated user's ID |
| `auth.*` | Any field from the auth user's record (e.g., `auth.role`) |
| `params.*` | Action parameters (e.g., `params.email`) |
| Column names | Columns from the target table |

**Operators:** `==`, `!=`, `>`, `<`, `>=`, `<=`, `~` (LIKE), `&` (AND), `|` (OR)

### applyTableRules

Controls whether table-level RLS rules apply to steps:

```typescript
{
    name: 'admin_reset',
    applyTableRules: false,       // Bypass table rules (default: true)
    guard: "auth.role == 'admin'",  // Use guard for access control instead
    steps: { /* ... */ },
}
```

| Value | Behavior |
|-------|----------|
| `true` (default) | Table rules from the `rules` extension apply. Steps respect RLS. An INSERT/UPDATE step with `or: 'REPLACE'` is rejected (403) for non-admin callers unless the table's `deleteRule` is `'true'` (no trigger on that event, never on auth tables), because REPLACE deletes conflicting rows without checking `deleteRule`. |
| `false` | Rules are skipped. The action has unrestricted access, including `noInsert`/`noUpdate` columns and the admin-only auth columns (`role`, `email_verified`, `password_salt`). Use `guard` or `requireAuth` for access control. |

---

## Parameters

Define typed parameters that are validated before the action executes.

### Shorthand

```typescript
params: {
    email: 'string',
    amount: 'number',
    active: 'boolean',
    page: 'integer',
}
```

### Full Definition

```typescript
params: {
    email: { type: 'string', description: 'User email address' },
    page: { type: 'integer', optional: true, default: 1 },
    limit: { type: 'integer', optional: true, default: 10, description: 'Max results' },
}
```

### Parameter Types

| Type | Description | Example |
|------|-------------|---------|
| `'string'` | Any text value | `"alice@example.com"` |
| `'number'` | Floating-point or integer | `3.14` |
| `'integer'` | Integer only | `42` |
| `'boolean'` | `true` or `false` | `true` |

### Param Options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `type` | `string` | — | Parameter type (required). |
| `optional` | `boolean` | `false` | Allow the parameter to be omitted. |
| `default` | `any` | — | Default value when omitted. Only used if `optional`. |
| `description` | `string` | — | Description for OpenAPI docs. Max 500 characters. |

### Validation

Parameters are validated using Zod schemas built from your definition. Strict mode is enabled — extra parameters not defined in `params` are rejected.

**Error response (400):**

```json
{
    "code": 400,
    "message": "Validation Error",
    "data": {
        "email": { "_errors": ["Required"] },
        "amount": { "_errors": ["Expected number, received string"] }
    }
}
```

---

## Access Control

Actions have two layers of access control: `requireAuth` and `guard`.

### requireAuth

The simplest check — does the request have a valid JWT token?

```typescript
{
    name: 'my_action',
    requireAuth: true,        // 401 if not authenticated
    // ...
}
```

Checked **before** the guard and before any SQL execution.

**Error response (401):**

```json
{ "code": 401, "message": "Authentication required" }
```

### Guard Expressions

Guards are expressions evaluated before the action executes. If the expression evaluates to false, the request is rejected with 403.

```typescript
{
    name: 'admin_action',
    guard: "auth.uid != null",    // Must be logged in
    // ...
}

{
    name: 'admin_only',
    guard: "auth.role == 'admin'",  // Must be admin
    // ...
}
```

**Available variables in guards:**
- `auth.*` — authenticated user context (uid, email, role, etc.)
- `params.*` — action parameters
- SQLite functions like `unixepoch()` for time-based guards

**How guards work internally:**

1. If the expression fully resolves to a literal (e.g., `auth.uid != null` where `auth.uid` is known), it's evaluated immediately in JavaScript.
2. If it uses SQLite functions, it's wrapped as a SQL statement and executed in the same transaction as the action queries. If it fails, the entire transaction is rolled back.

**Error response (403):**

```json
{ "code": 403, "message": "Forbidden" }
```

### Combining Both

```typescript
{
    name: 'sensitive_action',
    requireAuth: true,                    // First: must be authenticated
    guard: "auth.role == 'admin'",        // Then: must be admin
    params: { target_id: 'string' },
    sql: { /* ... */ },
}
```

Evaluation order: `requireAuth` → `guard` → parameter validation → SQL execution.

---

## Sensitive Field Filtering

When using `returning: ['*']` in SQL mode, sensitive fields are excluded from the response: `noSelect: true` fields for non-admin callers, and the auth password hash and salt (`auth_password` / `auth_password_salt` usage) for every caller, admins included.

```typescript
// Field definition
{ name: 'password', type: 'text', sqlType: 'text', noSelect: true }

// Action with returning: ['*']
{
    name: 'rename_user',
    params: { id: 'string', name: 'string' },
    sql: {
        type: 'UPDATE',
        table: 'users',
        set: { name: sql`{:name}` },
        where: sql`id = {:id}`,
        returning: ['*'],              // password will be excluded
    },
}
```

**Response:** Includes all fields *except* `password`, `password_salt`, and any other `noSelect` fields.

Admin callers (service token, Pocket UI logins) also get the other `noSelect` fields, but never the password hash or salt. An explicit `returning: ['password']` in SQL mode is passed through as written, so don't list secret columns in an action you expose.

---

## API Reference

### Endpoint

`POST /api/v1/action/{name}`

### Request

**Headers:**
- `Content-Type: application/json`
- `Authorization: Bearer {token}` (if `requireAuth: true` or `guard` uses auth context)

**Body:** JSON object with parameter values matching the action's `params` definition.

```json
{ "email": "alice@example.com", "amount": 5 }
```

### Response

**Success (200):** Array of arrays — each element corresponds to one query's results.

```json
// Single query
[[{ "id": "abc123", "email_verified": true }]]

// Multiple queries
[
    [{ "id": "abc123", "credits": 95 }],
    [{ "id": "def456", "credits": 105 }]
]
```

**Errors:**

| Status | Condition | Body |
|--------|-----------|------|
| 400 | Invalid parameters or request body | `{ "code": 400, "message": "...", "data": {...} }` |
| 401 | `requireAuth: true` but no valid token | `{ "code": 401, "message": "Authentication required" }` |
| 403 | Guard expression failed | `{ "code": 403, "message": "Forbidden" }` |
| 404 | Action name not found | `{ "code": 404, "message": "Action not found - {name}" }` |
| 500 | SQL execution error or misconfiguration | `{ "code": 500, "message": "..." }` |

### Calling from Worker Code

Use `db.runAction()` to call actions from your worker code (SSR routes, custom middleware, etc.) without an HTTP round-trip:

```typescript
// In an SSR route handler or custom middleware
const db = c.get('$db')
const results = await db.runAction('increment_counter', { amount: 1 })

// Fire-and-forget (non-critical operations like view counting)
c.executionCtx.waitUntil(
    db.runAction('increment_view', { slug }).catch(() => {})
)
```

`runAction` executes the action directly — same validation, guards, and SQL execution as the HTTP endpoint.

---

## Examples

### Read-only query with params

Fetch posts by category with pagination.

```typescript
{
    name: 'posts_by_category',
    params: {
        category: 'string',
        page: { type: 'integer', optional: true, default: 1 },
        limit: { type: 'integer', optional: true, default: 20 },
    },
    sql: {
        type: 'SELECT',
        table: 'posts',
        where: sql`category = {:category} AND published = true`,
        orderBy: 'created DESC',
        limit: 20,     // Note: dynamic limit from params requires steps mode
        offset: 0,
    },
}
```

> **Pagination note.** The `limit` and `offset` fields take literal numbers — they're inlined into the SQL string, not parameterized. To paginate via request params, use steps mode (see [steps](#steps-mode) below) where you can compute `LIMIT`/`OFFSET` from params inside a step.

```bash
curl -X POST http://localhost:8787/api/v1/action/posts_by_category \
  -H 'Content-Type: application/json' \
  -d '{ "category": "tech" }'
```

### Mutation with auth check

Mark a user's email as verified (admin-only).

```typescript
{
    name: 'admin_verify_email',
    requireAuth: true,
    guard: "auth.role == 'admin'",
    params: { user_id: 'string' },
    sql: {
        type: 'UPDATE',
        table: 'users',
        set: { email_verified: sqlValue(true) },
        where: sql`id = {:user_id} AND email_verified = false`,
        returning: ['id', 'email', 'email_verified'],
    },
}
```

### Multi-step workflow

Soft-delete a post and log the action.

```typescript
{
    name: 'soft_delete_post',
    requireAuth: true,
    params: { post_id: 'string' },
    applyTableRules: false,
    guard: "auth.uid != null",
    steps: [
        {
            type: 'UPDATE',
            table: 'posts',
            setValues: { deleted: true },
            where: "id = params.post_id & author_id = auth.uid",
        },
        {
            type: 'INSERT',
            table: 'audit_log',
            expr: {
                user_id: 'auth.uid',
                action: "'delete_post'",
                target_id: 'params.post_id',
            },
        },
    ],
}
```

### Aggregation / reporting query

Get user registration stats.

```typescript
{
    name: 'registration_stats',
    requireAuth: true,
    guard: "auth.role == 'admin'",
    sql: {
        type: 'SELECT',
        table: 'users',
        selects: [
            { q: "strftime('%Y-%m', created)", as: 'month' },
            { q: 'COUNT(*)', as: 'count' },
        ],
        groupBy: ["strftime('%Y-%m', created)"],
        orderBy: 'month DESC',
        limit: 12,
    },
}
```

```json
[[
    { "month": "2025-03", "count": 142 },
    { "month": "2025-02", "count": 98 },
    { "month": "2025-01", "count": 67 }
]]
```

---

## Common Mistakes

- **Having both `sql` and `steps`.** An action must use one or the other, not both. You'll get a 500 error.
- **Forgetting `requireAuth` on mutations.** Without it, anyone can call the action — even unauthenticated requests.
- **Using `params.*` in SQL mode.** SQL mode uses `{:paramName}` syntax in `sql` tagged templates. `params.*` syntax is for steps mode expressions only.
- **Expecting `applyTableRules` in SQL mode.** SQL mode always bypasses table rules. Only steps mode respects `applyTableRules`.

---

[Back to README](../README.md) | [Configuration Reference](config-reference.md) | [API Endpoints](api-endpoints.md)
