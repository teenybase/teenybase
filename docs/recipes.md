# Recipes & Patterns

> Copy-paste configs and API calls for common use cases. Each recipe is self-contained — grab what you need.

**Prerequisites:** You have a teenybase project running locally (`npx teenybase dev`). If not, see [Getting Started](getting-started.md).

---

## Table of Contents

- [Counter / View Tracker](#counter--view-tracker)
- [Soft Delete](#soft-delete)
- [Role-Based Access Control](#role-based-access-control)
- [Multi-Table Blog](#multi-table-blog)
- [File Upload Gallery](#file-upload-gallery)
- [User Preferences (Upsert)](#user-preferences-upsert)
- [Full-Text Search](#full-text-search)
- [Aggregation Dashboard](#aggregation-dashboard)
- [Leaderboard with Ranking](#leaderboard-with-ranking)
- [Email Verification Flow](#email-verification-flow)
- [Cascading Delete](#cascading-delete)
- [Key-Value Store](#key-value-store)
- [Rate Limiting (Manual)](#rate-limiting-manual)
- [Scheduled Cleanup via External Cron](#scheduled-cleanup-via-external-cron)

---

## Counter / View Tracker

Track page views, link clicks, or any incrementing value — without giving users direct UPDATE access to the counter field.

### The idea

Mark the counter field as `noUpdate: true` so regular CRUD can't touch it. Then expose an action that increments it.

### Config

```typescript
// teenybase.ts
import { DatabaseSettings, sql, sqlValue, TableRulesExtensionData } from 'teenybase'
import { baseFields, createdTrigger, updatedTrigger } from 'teenybase/scaffolds/fields'

export default {
    appUrl: 'http://localhost:8787',
    jwtSecret: '$JWT_SECRET',
    tables: [{
        name: 'links',
        autoSetUid: true,
        fields: [
            ...baseFields,
            { name: 'url', type: 'url', sqlType: 'text', notNull: true },
            { name: 'title', type: 'text', sqlType: 'text', notNull: true },
            { name: 'clicks', type: 'integer', sqlType: 'integer', notNull: true,
              default: sqlValue(0), noInsert: true, noUpdate: true },
        ],
        triggers: [createdTrigger, updatedTrigger],
        extensions: [{
            name: 'rules',
            listRule: 'true',
            viewRule: 'true',
            createRule: 'auth.uid != null',
            updateRule: 'auth.uid != null',
            deleteRule: 'auth.uid != null',
        } as TableRulesExtensionData],
    }],
    actions: [{
        name: 'click',
        params: { link_id: 'string' },
        applyTableRules: false,
        sql: {
            type: 'UPDATE',
            table: 'links',
            set: { clicks: sql`clicks + 1` },
            where: sql`id = {:link_id}`,
            returning: ['clicks'],
        },
    }],
} satisfies DatabaseSettings
```

### API calls

```bash
# Create a link (authenticated)
curl -X POST http://localhost:8787/api/v1/table/links/insert \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"values": {"url": "https://example.com", "title": "Example"}}'

# Increment clicks (no auth required — public counter)
curl -X POST http://localhost:8787/api/v1/action/click \
  -H 'Content-Type: application/json' \
  -d '{"link_id": "abc123"}'
# → [[{"clicks": 1}]]

# Increment again
curl -X POST http://localhost:8787/api/v1/action/click \
  -H 'Content-Type: application/json' \
  -d '{"link_id": "abc123"}'
# → [[{"clicks": 2}]]
```

`★ Insight ─────────────────────────────────────`
The `noUpdate: true` on the `clicks` field is what makes this safe. Users can't set `clicks` to 999 via the regular `/update` endpoint — only the action can modify it, because actions with `applyTableRules: false` bypass field restrictions and execute raw SQL.
`─────────────────────────────────────────────────`

---

## Soft Delete

Mark records as deleted without removing them from the database. Useful for audit trails, undo functionality, or legal retention requirements.

### Config

```typescript
{
    name: 'documents',
    autoSetUid: true,
    fields: [
        ...baseFields,
        { name: 'title', type: 'text', sqlType: 'text', notNull: true },
        { name: 'content', type: 'editor', sqlType: 'text' },
        { name: 'owner_id', type: 'relation', sqlType: 'text', notNull: true,
          foreignKey: { table: 'users', column: 'id' } },
        { name: 'deleted_by', type: 'relation', sqlType: 'text',
          foreignKey: { table: 'users', column: 'id', onDelete: 'SET NULL' } },
        { name: 'deleted_at', type: 'date', sqlType: 'timestamp' },
    ],
    triggers: [createdTrigger, updatedTrigger, {
        // Auto-set deleted_at when deleted_by is set
        name: 'set_deleted_at_on_delete_by',
        seq: 'BEFORE',
        event: 'UPDATE',
        updateOf: 'deleted_by',
        body: sql`UPDATE documents SET deleted_at = CURRENT_TIMESTAMP
                  WHERE id = NEW.id
                  AND OLD.deleted_by IS NULL
                  AND NEW.deleted_by IS NOT NULL`,
    }],
    indexes: [
        { fields: 'owner_id' },
        { fields: 'deleted_by' },
    ],
    extensions: [{
        name: 'rules',
        // Hide soft-deleted records from non-admins
        listRule: '(!deleted_at | auth.role == "admin") & (auth.uid == owner_id | auth.role == "admin")',
        viewRule: '(!deleted_at | auth.role == "admin") & (auth.uid == owner_id | auth.role == "admin")',
        createRule: 'auth.uid != null & owner_id == auth.uid',
        updateRule: 'auth.uid == owner_id',
        deleteRule: null, // No hard deletes — use soft delete instead
    } as TableRulesExtensionData],
}
```

### API calls

```bash
# Soft-delete a document (set deleted_by to current user)
curl -X POST http://localhost:8787/api/v1/table/documents/edit/DOC_ID \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"setValues": {"deleted_by": "USER_ID"}}'

# The trigger auto-sets deleted_at — no extra API call needed.
# List only shows non-deleted docs (rules filter them out).
```

### How it works

1. The `deleteRule: null` blocks all hard deletes via the API.
2. To "delete," you UPDATE the `deleted_by` field to the current user's ID.
3. The trigger automatically sets `deleted_at` to the current timestamp.
4. The `listRule` filters out records where `deleted_at` is set (for non-admins).

---

## Role-Based Access Control

Different users see different data. Admins see everything, regular users see their own records, guests see only public content.

### Config

```typescript
{
    name: 'users',
    autoSetUid: true,
    fields: [
        ...baseFields,
        ...authFields,
    ],
    triggers: [createdTrigger, updatedTrigger],
    extensions: [{
        name: 'rules',
        // Admins see all; users see only themselves
        listRule: '(auth.uid == id) | auth.role ~ "%admin"',
        viewRule: '(auth.uid == id) | auth.role ~ "%admin"',
        // New users default to 'guest' role; admins can create any role
        createRule: '(auth.uid == null & role == "guest") | auth.role ~ "%admin"',
        // Users can edit own profile but can't change role; admins can do anything
        updateRule: '(auth.uid == id & role == new.role) | auth.role ~ "%admin"',
        // Only admins can delete users
        deleteRule: 'auth.role ~ "%admin"',
    } as TableRulesExtensionData, {
        name: 'auth',
        // ... auth extension config
    } as TableAuthExtensionData],
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
        { name: 'is_public', type: 'bool', sqlType: 'boolean', default: sqlValue(false) },
    ],
    triggers: [createdTrigger, updatedTrigger],
    indexes: [{ fields: 'author_id' }],
    extensions: [{
        name: 'rules',
        // Public posts visible to all; private posts only to author and admins
        listRule: 'is_public == true | auth.uid == author_id | auth.role ~ "%admin"',
        viewRule: 'is_public == true | auth.uid == author_id | auth.role ~ "%admin"',
        createRule: 'auth.uid != null & author_id == auth.uid',
        updateRule: 'auth.uid == author_id | auth.role ~ "%admin"',
        deleteRule: 'auth.uid == author_id | auth.role ~ "%admin"',
    } as TableRulesExtensionData],
}
```

### Key patterns

- **`auth.role ~ "%admin"`** — the `~` operator is LIKE in SQL. This matches roles ending in "admin" (e.g., `"admin"`, `"superadmin"`).
- **`role == new.role`** — prevents users from escalating their own role. The `new.` prefix references the incoming update value.
- **`auth.uid == null`** — matches unauthenticated requests (sign-up flow).

---

## Multi-Table Blog

Posts, comments, and tags with relationships, indexes, and cascading behavior.

### Config

```typescript
// Tables array (users table omitted — use the standard auth scaffold)
{
    name: 'posts',
    autoSetUid: true,
    fields: [
        ...baseFields,
        { name: 'author_id', type: 'relation', sqlType: 'text', notNull: true,
          foreignKey: { table: 'users', column: 'id' } },
        { name: 'title', type: 'text', sqlType: 'text', notNull: true },
        { name: 'slug', type: 'text', sqlType: 'text', notNull: true, unique: true },
        { name: 'body', type: 'editor', sqlType: 'text' },
        { name: 'published', type: 'bool', sqlType: 'boolean', default: sqlValue(false) },
        { name: 'tags', type: 'text', sqlType: 'text' }, // comma-separated or JSON
    ],
    triggers: [createdTrigger, updatedTrigger],
    indexes: [
        { fields: 'author_id' },
        { fields: 'slug' },
        { fields: 'published' },
    ],
    extensions: [{
        name: 'rules',
        listRule: 'published == true | auth.uid == author_id',
        viewRule: 'published == true | auth.uid == author_id',
        createRule: 'auth.uid != null & author_id == auth.uid',
        updateRule: 'auth.uid == author_id',
        deleteRule: 'auth.uid == author_id',
    } as TableRulesExtensionData],
},
{
    name: 'comments',
    autoSetUid: true,
    fields: [
        ...baseFields,
        { name: 'post_id', type: 'relation', sqlType: 'text', notNull: true,
          foreignKey: { table: 'posts', column: 'id', onDelete: 'CASCADE' } },
        { name: 'author_id', type: 'relation', sqlType: 'text', notNull: true,
          foreignKey: { table: 'users', column: 'id' } },
        { name: 'body', type: 'text', sqlType: 'text', notNull: true },
    ],
    triggers: [createdTrigger, updatedTrigger],
    indexes: [
        { fields: 'post_id' },
        { fields: 'author_id' },
    ],
    extensions: [{
        name: 'rules',
        listRule: 'true',   // anyone can read comments
        viewRule: 'true',
        createRule: 'auth.uid != null & author_id == auth.uid',
        updateRule: 'auth.uid == author_id',
        deleteRule: 'auth.uid == author_id',
    } as TableRulesExtensionData],
}
```

### API calls

```bash
# Create a post
curl -X POST http://localhost:8787/api/v1/table/posts/insert \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"values": {
    "author_id": "USER_ID",
    "title": "Hello World",
    "slug": "hello-world",
    "body": "<p>My first post</p>",
    "published": true,
    "tags": "intro,hello"
  }}'

# List published posts (no auth needed)
curl 'http://localhost:8787/api/v1/table/posts/list?order=created%20desc&limit=10'

# Get comments for a post
curl 'http://localhost:8787/api/v1/table/comments/list?where=post_id%3D%22POST_ID%22'

# Delete a post — comments are automatically deleted (CASCADE)
curl -X POST http://localhost:8787/api/v1/table/posts/delete \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"where": "id = \"POST_ID\""}'
```

---

## File Upload Gallery

Upload images with metadata, serve them back, and auto-clean storage on delete.

### Config

```typescript
{
    name: 'images',
    autoSetUid: true,
    r2Base: 'gallery',           // R2 bucket prefix for this table
    autoDeleteR2Files: true,     // delete files from R2 when record is deleted
    fields: [
        ...baseFields,
        { name: 'owner_id', type: 'relation', sqlType: 'text', notNull: true,
          foreignKey: { table: 'users', column: 'id', onDelete: 'CASCADE' } },
        { name: 'title', type: 'text', sqlType: 'text', notNull: true },
        { name: 'file', type: 'file', sqlType: 'text', notNull: true },
        { name: 'thumb', type: 'file', sqlType: 'text' },
        { name: 'caption', type: 'text', sqlType: 'text' },
    ],
    triggers: [createdTrigger, updatedTrigger],
    indexes: [{ fields: 'owner_id' }],
    extensions: [{
        name: 'rules',
        listRule: 'true',
        viewRule: 'true',
        createRule: 'auth.uid != null & owner_id == auth.uid',
        updateRule: 'auth.uid == owner_id',
        deleteRule: 'auth.uid == owner_id',
    } as TableRulesExtensionData],
}
```

### Upload a file

Files are uploaded via multipart/form-data. Use `@filePayload` for the actual file and `@jsonPayload` for the record data.

```bash
curl -X POST http://localhost:8787/api/v1/table/images/insert \
  -H 'Authorization: Bearer <token>' \
  -F '@jsonPayload={"values":{"owner_id":"USER_ID","title":"Sunset"}};type=application/json' \
  -F '@filePayload[file]=@/path/to/sunset.jpg'
```

### Download a file

```
GET http://localhost:8787/api/v1/files/<table>/<record_id>/<field_name>/<file_name>
```

Example:
```
http://localhost:8787/api/v1/files/images/abc123/file/sunset.jpg
```

### Delete (auto-cleans R2)

```bash
curl -X POST http://localhost:8787/api/v1/table/images/delete \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"where": "id = \"abc123\""}'
```

With `autoDeleteR2Files: true`, the actual file in R2 is deleted when the record is deleted. No orphaned files.

---

## User Preferences (Upsert)

Store per-user settings as key-value pairs: create a preference if the user doesn't have it yet, update it if they do. A unique index on `(user_id, key)` plus two rule-checked calls does this without letting one user touch another user's rows.

### Config

```typescript
{
    name: 'preferences',
    autoSetUid: true,
    fields: [
        { name: 'id', type: 'text', sqlType: 'text', primary: true, notNull: true,
          usage: 'record_uid', noUpdate: true },
        { name: 'created', type: 'date', sqlType: 'timestamp',
          default: sql`CURRENT_TIMESTAMP`, notNull: true, usage: 'record_created',
          noInsert: true, noUpdate: true },
        { name: 'updated', type: 'date', sqlType: 'timestamp',
          default: sql`CURRENT_TIMESTAMP`, notNull: true, usage: 'record_updated',
          noInsert: true, noUpdate: true },
        { name: 'user_id', type: 'relation', sqlType: 'text', notNull: true,
          foreignKey: { table: 'users', column: 'id', onDelete: 'CASCADE' } },
        { name: 'key', type: 'text', sqlType: 'text', notNull: true },
        { name: 'val', type: 'text', sqlType: 'text' },
    ],
    triggers: [createdTrigger, updatedTrigger],
    indexes: [
        { fields: ['user_id', 'key'], unique: true },  // one row per user and key
    ],
    extensions: [{
        name: 'rules',
        listRule: 'auth.uid == user_id',
        viewRule: 'auth.uid == user_id',
        createRule: 'auth.uid != null & user_id == auth.uid',
        updateRule: 'auth.uid == user_id & user_id == new.user_id',  // can't hand a row to another user
        deleteRule: 'auth.uid == user_id',
    } as TableRulesExtensionData],
}
```

### API calls

```bash
# 1. Create the preference. If this user already has the key, the unique index conflict
#    is skipped: the response is [] instead of the new row.
curl -X POST http://localhost:8787/api/v1/table/preferences/insert \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"or": "IGNORE", "values": {"user_id": "USER_ID", "key": "theme", "val": "dark"}, "returning": ["id"]}'

# 2. Only if step 1 returned []: update the existing row.
curl -X POST http://localhost:8787/api/v1/table/preferences/update \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"where": "user_id = \"USER_ID\" & key = \"theme\"", "setValues": {"val": "dark"}, "returning": ["id", "val"]}'

# Get all preferences for a user
curl 'http://localhost:8787/api/v1/table/preferences/select?where=user_id%3D%22USER_ID%22' \
  -H 'Authorization: Bearer <token>'
```

Step 1 is checked against `createRule` and step 2 against `updateRule`, so another user can neither create a row under your `user_id` nor change yours. `IGNORE` also skips a row that fails a `NOT NULL` or `CHECK` constraint, so validate values before sending them.

Don't use `edit/:id?or=INSERT` (`INSERT OR REPLACE`) for this. `REPLACE` deletes the conflicting row without checking `deleteRule`, so it is rejected with 403 for non-admin users on any table whose `deleteRule` isn't `'true'`, has a trigger on that event, or is an auth table.

---

## Full-Text Search

Add search across text fields using SQLite FTS5. Configure in your table definition, query with the `@@` operator.

### Config

```typescript
{
    name: 'articles',
    autoSetUid: true,
    fields: [
        ...baseFields,
        { name: 'title', type: 'text', sqlType: 'text', notNull: true },
        { name: 'content', type: 'editor', sqlType: 'text' },
        { name: 'tags', type: 'text', sqlType: 'text' },
        { name: 'author_id', type: 'relation', sqlType: 'text',
          foreignKey: { table: 'users', column: 'id' } },
    ],
    triggers: [createdTrigger, updatedTrigger],
    // FTS5 index — searches title, content, and tags
    fullTextSearch: {
        fields: ['title', 'content', 'tags'],
        tokenize: 'trigram',   // good for partial matches and non-English text
    },
    extensions: [{
        name: 'rules',
        listRule: 'true',
        viewRule: 'true',
        createRule: 'auth.uid != null',
        updateRule: 'auth.uid != null',
        deleteRule: 'auth.uid != null',
    } as TableRulesExtensionData],
}
```

### Search queries

The `@@` operator triggers an FTS5 MATCH query. Results are automatically ordered by relevance (rank).

```bash
# Search across all indexed fields
curl 'http://localhost:8787/api/v1/table/articles/list' \
  -H 'Content-Type: application/json' \
  -d '{"where": "articles @@ \"search term\""}'

# Search a specific column
curl 'http://localhost:8787/api/v1/table/articles/list' \
  -H 'Content-Type: application/json' \
  -d '{"where": "title @@ \"search term\""}'

# Combine search with other filters
curl 'http://localhost:8787/api/v1/table/articles/list' \
  -H 'Content-Type: application/json' \
  -d '{"where": "articles @@ \"typescript\" & author_id == \"USER_ID\""}'
```

### Tokenizer options

| Tokenizer | Best for | Example |
|-----------|----------|---------|
| `unicode61` | General text (default) | Full word matches across languages |
| `porter` | English text | Stems words: "running" matches "run" |
| `trigram` | Partial matches, autocomplete | "typ" matches "typescript" |
| `ascii` | ASCII-only text | Fast, simple matching |

---

## Aggregation Dashboard

Use actions to run aggregate queries — monthly signups, daily counts, totals. Actions can execute raw SQL that regular CRUD endpoints can't.

### Config

```typescript
actions: [
    {
        name: 'monthly_signups',
        description: 'Count new users grouped by month',
        requireAuth: true,
        applyTableRules: false,
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
    },
    {
        name: 'table_stats',
        description: 'Record count per table',
        requireAuth: true,
        guard: 'auth.role ~ "%admin"',
        applyTableRules: false,
        sql: [
            { type: 'SELECT', table: 'users', selects: [{ q: 'COUNT(*)', as: 'count' }] },
            { type: 'SELECT', table: 'posts', selects: [{ q: 'COUNT(*)', as: 'count' }] },
            { type: 'SELECT', table: 'comments', selects: [{ q: 'COUNT(*)', as: 'count' }] },
        ],
    },
]
```

### API calls

```bash
# Monthly signups (requires auth)
curl -X POST http://localhost:8787/api/v1/action/monthly_signups \
  -H 'Authorization: Bearer <token>'
# → [[{"month": "2025-03", "count": 42}, {"month": "2025-02", "count": 38}, ...]]

# Table stats (requires admin)
curl -X POST http://localhost:8787/api/v1/action/table_stats \
  -H 'Authorization: Bearer <token>'
# → [[{"count": 150}], [{"count": 89}], [{"count": 312}]]
#     ^ users            ^ posts           ^ comments
```

`★ Insight ─────────────────────────────────────`
When an action has multiple SQL queries (array), the response is an array of arrays — one result set per query, in order. The `table_stats` example above returns `[[users count], [posts count], [comments count]]`.
`─────────────────────────────────────────────────`

---

## Leaderboard with Ranking

Top N users by score, with rank numbers. Uses `ROW_NUMBER()` window function in a raw SQL action.

### Config

Add a `score` field to your users table (or a separate `scores` table), then define the action:

```typescript
actions: [{
    name: 'leaderboard',
    description: 'Top 10 users by score with rank',
    applyTableRules: false,
    sql: {
        type: 'SELECT',
        table: 'scores',
        selects: [
            { q: 'ROW_NUMBER() OVER (ORDER BY score DESC)', as: 'rank' },
            'user_id',
            'score',
        ],
        orderBy: 'score DESC',
        limit: 10,
    },
}]
```

### API call

```bash
curl -X POST http://localhost:8787/api/v1/action/leaderboard
# → [[{"rank": 1, "user_id": "abc", "score": 980},
#     {"rank": 2, "user_id": "def", "score": 870}, ...]]
```

---

## Email Verification Flow

Full sign-up → verify email → login flow using the built-in auth extension with an email provider.

### Config

```typescript
export default {
    appUrl: 'https://myapp.com',
    jwtSecret: '$JWT_SECRET',
    email: {
        from: 'My App <noreply@myapp.com>',
        variables: {
            company_name: 'My App',
            company_url: 'https://myapp.com',
            company_address: '123 Main St',
            company_copyright: '© 2025 My App',
            support_email: 'support@myapp.com',
        },
        resend: {
            RESEND_API_KEY: '$RESEND_API_KEY',
        },
    },
    tables: [{
        name: 'users',
        autoSetUid: true,
        fields: [...baseFields, ...authFields],
        triggers: [createdTrigger, updatedTrigger],
        extensions: [{
            name: 'rules',
            listRule: 'auth.uid == id',
            viewRule: 'auth.uid == id',
            createRule: 'true',
            updateRule: 'auth.uid == id',
            deleteRule: null,
        } as TableRulesExtensionData, {
            name: 'auth',
            jwtSecret: '$JWT_SECRET',
            jwtTokenDuration: 3600,
            maxTokenRefresh: 4,
            autoSendVerificationEmail: true,   // sends on sign-up automatically
        } as TableAuthExtensionData],
    }],
} satisfies DatabaseSettings
```

### The flow

```bash
# 1. Sign up — verification email is auto-sent because autoSendVerificationEmail: true
curl -X POST http://localhost:8787/api/v1/table/users/auth/sign-up \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "alice",
    "email": "alice@example.com",
    "password": "strongpassword",
    "name": "Alice"
  }'
# → Returns token + refreshToken. email_verified is false. Verification email already on its way.

# 2. User clicks link in email — frontend extracts the token and POSTs to confirm
curl -X POST http://localhost:8787/api/v1/table/users/auth/confirm-verification \
  -H 'Content-Type: application/json' \
  -d '{"token": "VERIFICATION_TOKEN_FROM_EMAIL"}'
# → email_verified is now true

# 3. Login (normal flow)
curl -X POST http://localhost:8787/api/v1/table/users/auth/login-password \
  -H 'Content-Type: application/json' \
  -d '{"identity": "alice@example.com", "password": "strongpassword"}'
```

### Resending the verification email

Use this when the user didn't receive the first email or it expired. Requires the user to be logged in — the endpoint identifies them by JWT, not by a request body.

```bash
curl -X POST http://localhost:8787/api/v1/table/users/auth/request-verification \
  -H "Authorization: Bearer $TOKEN"
# → 200 {success: true}. 400 if already verified. 403 without auth.
```

### Email providers

Teenybase supports **Resend**, **Mailgun**, and **Cloudflare Email Service**. For Resend or Mailgun, set the API key in your `.prod.vars` file and reference it with `$`:

```env
# .prod.vars
RESEND_API_KEY=re_xxxxxxxxxxxxx
```

For local development, add `mock: true` to the email config to log emails to the console instead of sending them.

---

## Cascading Delete

Delete a user → automatically delete all their posts, comments, and files. Set up foreign keys with `onDelete: 'CASCADE'`.

### Config

```typescript
// posts table
{ name: 'author_id', type: 'relation', sqlType: 'text', notNull: true,
  foreignKey: { table: 'users', column: 'id', onDelete: 'CASCADE' } },

// comments table
{ name: 'post_id', type: 'relation', sqlType: 'text', notNull: true,
  foreignKey: { table: 'posts', column: 'id', onDelete: 'CASCADE' } },
{ name: 'author_id', type: 'relation', sqlType: 'text', notNull: true,
  foreignKey: { table: 'users', column: 'id', onDelete: 'CASCADE' } },

// files table (with R2 cleanup)
{ name: 'owner_id', type: 'relation', sqlType: 'text', notNull: true,
  foreignKey: { table: 'users', column: 'id', onDelete: 'CASCADE' } },
```

Set `autoDeleteR2Files: true` (default) on tables with `type: 'file'` fields. When a record is deleted — whether directly or via CASCADE — its files are removed from object storage.

### Other onDelete options

| Value | Behavior |
|-------|----------|
| `CASCADE` | Delete child records when parent is deleted |
| `SET NULL` | Set the foreign key to NULL (field must not be `notNull`) |
| `RESTRICT` | Block the delete if child records exist |
| `NO ACTION` | Same as RESTRICT in SQLite |
| `SET DEFAULT` | Set to the field's default value |

---

## Key-Value Store

A simple config/settings table with manual IDs (not auto-generated). Useful for app-wide settings, feature flags, or any key-value data.

### Config

```typescript
{
    name: 'config',
    autoSetUid: false,  // manual IDs — the key IS the ID
    fields: [
        ...baseFields.filter(f => f.name !== 'id'),
        { name: 'id', type: 'text', sqlType: 'text', primary: true, notNull: true,
          usage: 'record_uid', noUpdate: false },  // allow ID updates (rename keys)
        { name: 'val', type: 'text', sqlType: 'text' },
        { name: 'protected', type: 'bool', sqlType: 'boolean', notNull: true,
          default: sqlValue(false) },
    ],
    triggers: [createdTrigger, updatedTrigger],
    extensions: [{
        name: 'rules',
        // Non-protected keys are readable by everyone; protected keys require admin
        listRule: '!protected | auth.role ~ "%admin"',
        viewRule: '!protected | auth.role ~ "%admin"',
        createRule: 'auth.role ~ "%admin"',
        updateRule: 'auth.role ~ "%admin"',
        deleteRule: 'auth.role ~ "%admin"',
    } as TableRulesExtensionData],
}
```

### API calls

```bash
# Set a config value (admin only)
curl -X POST http://localhost:8787/api/v1/table/config/edit/site_name \
  -H 'Authorization: Bearer <admin-token>' \
  -H 'Content-Type: application/json' \
  -d '{"setValues": {"val": "My Cool App"}, "or": "INSERT"}'

# Read a config value (public, if not protected)
curl http://localhost:8787/api/v1/table/config/view/site_name
```

---

## Rate Limiting (Manual)

Prevent abuse on public endpoints by splitting the flow into two actions — one to check the limit, one to do the work. The client checks first, then submits.

> **Note:** Teenybase doesn't have built-in rate limiting yet. This is a manual workaround. For production use, consider adding rate limiting in a custom Hono middleware (see [Existing Hono Projects](existing-hono-project.md)).

### Config

```typescript
// Add a request_log table
{
    name: 'request_log',
    autoSetUid: true,
    fields: [
        ...baseFields,
        { name: 'action_name', type: 'text', sqlType: 'text', notNull: true },
        { name: 'ip_hash', type: 'text', sqlType: 'text', notNull: true },
    ],
    triggers: [createdTrigger],
    indexes: [
        { fields: 'action_name' },
        { fields: 'ip_hash' },
    ],
    extensions: [{
        name: 'rules',
        listRule: null,    // no direct access
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
    } as TableRulesExtensionData],
},

// Then in your actions:
actions: [
    {
        // Action 1: Submit form + log the request
        name: 'submit_form',
        params: { email: 'string', message: 'string', ip_hash: 'string' },
        applyTableRules: false,
        sql: [
            // Log this request
            {
                type: 'INSERT',
                table: 'request_log',
                values: {
                    action_name: sql`'submit_form'`,
                    ip_hash: sql`{:ip_hash}`,
                },
            },
            // Do the actual work
            {
                type: 'INSERT',
                table: 'submissions',
                values: {
                    email: sql`{:email}`,
                    message: sql`{:message}`,
                },
                returning: ['id'],
            },
        ],
    },
    {
        // Action 2: Check rate limit (call this first from your client)
        name: 'check_rate_limit',
        params: { action_name: 'string', ip_hash: 'string' },
        applyTableRules: false,
        sql: {
            type: 'SELECT',
            table: 'request_log',
            selects: [{ q: 'COUNT(*)', as: 'count' }],
            where: sql`action_name = {:action_name} AND ip_hash = {:ip_hash} AND created > datetime('now', '-1 hour')`,
        },
    },
]
```

### API calls

```javascript
// Client-side: check rate limit, then submit
const checkRes = await fetch('/api/v1/action/check_rate_limit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action_name: 'submit_form', ip_hash: hashedIp }),
});
const [[{ count }]] = await checkRes.json();

if (count >= 5) {
    alert('Too many requests. Please try again later.');
} else {
    await fetch('/api/v1/action/submit_form', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, message, ip_hash: hashedIp }),
    });
}
```

> **Caveat:** This is not bulletproof — a determined user can skip the check and call `submit_form` directly. For server-side enforcement, add rate limiting in a custom Hono middleware before the teenybase routes.

---

## Scheduled Cleanup via External Cron

Delete expired records on a schedule by calling an action from an external cron service (GitHub Actions, cron-job.org, or a Cloudflare Worker Cron Trigger).

### Config

```typescript
actions: [{
    name: 'cleanup_expired',
    description: 'Delete records older than 30 days',
    requireAuth: true,
    guard: 'auth.role == "service"',  // only callable by a service account
    applyTableRules: false,
    sql: [
        {
            type: 'DELETE',
            table: 'sessions',
            where: sql`created < datetime('now', '-30 days')`,
            returning: ['*'],
        },
        {
            type: 'DELETE',
            table: 'request_log',
            where: sql`created < datetime('now', '-7 days')`,
            returning: ['*'],
        },
    ],
}]
```

### Call from a cron

```bash
# Create a service account with role "service" via PocketUI or direct INSERT
# Then call with that account's token:

curl -X POST https://your-app.example.com/api/v1/action/cleanup_expired \
  -H 'Authorization: Bearer <service-account-token>'
# → [[{...expired sessions...}], [{...expired logs...}]]
```

### GitHub Actions example

```yaml
# .github/workflows/cleanup.yml
name: Scheduled Cleanup
on:
  schedule:
    - cron: '0 3 * * *'  # daily at 3am UTC
jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -X POST https://your-app.example.com/api/v1/action/cleanup_expired \
            -H 'Authorization: Bearer ${{ secrets.SERVICE_TOKEN }}'
```

---

## Quick Reference

### Common query parameters

| Parameter | Example | Description |
|-----------|---------|-------------|
| `where` | `author_id == "abc"` | Filter expression |
| `order` | `created desc` | Sort order |
| `limit` | `10` | Max records |
| `offset` | `20` | Skip records (pagination) |
| `select` | `id, title, created` | Return only these fields |
| `distinct` | `true` | Deduplicate results |
| `group` | `author_id` | Group by field |

### Endpoint cheatsheet

| Action | Method | Endpoint |
|--------|--------|----------|
| List (with count) | GET/POST | `/api/v1/table/{name}/list` |
| Select (no count) | GET/POST | `/api/v1/table/{name}/select` |
| View one | GET | `/api/v1/table/{name}/view/{id}` |
| Insert | POST | `/api/v1/table/{name}/insert` |
| Update (by filter) | POST | `/api/v1/table/{name}/update` |
| Edit (by ID) | POST | `/api/v1/table/{name}/edit/{id}` |
| Delete | POST | `/api/v1/table/{name}/delete` |
| Call action | POST | `/api/v1/action/{name}` |
| Download file | GET | `/api/v1/files/{table}/{id}/{field}/{filename}` |

---

## Next Steps

- [Configuration Reference](config-reference.md) — every option in detail
- [Actions Guide](actions-guide.md) — deep dive on sql mode, steps mode, guards
- [Frontend Guide](frontend-guide.md) — connecting from React, Vue, vanilla JS
- [Getting Started](getting-started.md) — set up from scratch
