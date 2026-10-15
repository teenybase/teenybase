# Configuration Reference

> Complete reference for `teenybase.ts` (or `teeny.config.ts`) — every option, every type, every field.

Teenybase is configured through a single TypeScript object that satisfies the `DatabaseSettings` type. This page documents every option.

---

## Quick Reference: What Field Type Should I Use?

| You're storing... | `type` | `sqlType` | Example |
|-------------------|--------|-----------|---------|
| Text (name, title, bio) | `'text'` | `'text'` | `{ name: 'title', type: 'text', sqlType: 'text' }` |
| A number (price, score) | `'number'` | `'real'` | `{ name: 'price', type: 'number', sqlType: 'real' }` |
| A whole number (count, age) | `'integer'` | `'integer'` | `{ name: 'age', type: 'integer', sqlType: 'integer' }` |
| True/false | `'bool'` | `'boolean'` | `{ name: 'active', type: 'bool', sqlType: 'boolean' }` |
| An email address | `'email'` | `'text'` | `{ name: 'email', type: 'email', sqlType: 'text' }` |
| A URL | `'url'` | `'text'` | `{ name: 'website', type: 'url', sqlType: 'text' }` |
| A date or timestamp | `'date'` | `'timestamp'` | `{ name: 'due', type: 'date', sqlType: 'timestamp' }` |
| JSON data | `'json'` | `'json'` | `{ name: 'config', type: 'json', sqlType: 'json' }` |
| A file (image, PDF) | `'file'` | `'text'` | `{ name: 'avatar', type: 'file', sqlType: 'text' }` |
| A link to another table | `'relation'` | `'text'` | `{ name: 'author_id', type: 'relation', sqlType: 'text', foreignKey: { table: 'users', column: 'id' } }` |
| A dropdown / enum | `'select'` | `'text'` | `{ name: 'status', type: 'select', sqlType: 'text' }` |
| Rich text / HTML | `'editor'` | `'text'` | `{ name: 'content', type: 'editor', sqlType: 'text' }` |

For the full list with all compatible `sqlType` options, see [Field Types](#field-types) below.

---

## DatabaseSettings (top-level)

```typescript
export default {
    appUrl: 'http://localhost:8787',
    jwtSecret: '$JWT_SECRET',
    tables: [],

    // Optional
    appName: 'My App',
    jwtIssuer: 'my-app',
    jwtAlgorithm: 'HS256',
    authProviders: [],                          // empty array is valid
    authCookie: { name: 'auth_token' },         // `name` is required when authCookie is set
    email: {                                    // when set, `from` and `variables` are required
        from: 'noreply@example.com',
        variables: {
            company_name: 'My App',
            company_url: 'https://my-app.com',
            company_address: '123 Main St',
            company_copyright: '2026 My App',
            support_email: 'support@my-app.com',
        },
        // pick one provider: mailgun / resend / cloudflare (see Email Configuration below)
    },
    actions: [],
    // version: stamped automatically by the CLI on each apply
} satisfies DatabaseSettings
```

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `appUrl` | `string` | Yes | — | Your app's URL. Used for OAuth redirects, email links, and CORS. |
| `jwtSecret` | `string` | Yes | — | Global JWT signing secret. Combined with table-level `jwtSecret` (concatenated) for table auth tokens. Prefix with `$` to resolve from env vars (e.g., `'$JWT_SECRET'`). |
| `tables` | `TableData[]` | Yes | — | Array of table definitions. Each becomes a SQLite table with REST endpoints. |
| `appName` | `string` | No | `'Teeny App'` | Application name, used in email templates as the `APP_NAME` variable. |
| `jwtIssuer` | `string` | No | `'$db'` | JWT `iss` claim value for tokens created by this instance. |
| `jwtAlgorithm` | `string` | No | `'HS256'` | JWT signing algorithm. |
| `authProviders` | `AuthProvider[]` | No | `[]` | External auth provider configurations — OAuth redirect flows, JWT verification, or both. See [Auth Providers](#auth-providers). |
| `allowedRedirectUrls` | `string[]` | No | — | Allowed redirect URLs after OAuth login (exact match). When not set, URLs matching `appUrl` hostname are allowed. See [OAuth Guide](oauth-guide.md). |
| `authCookie` | `AuthCookieConfig` | No | — | Cookie-based auth for SSR and OAuth flows. See [Auth Cookie](#auth-cookie). |
| `email` | `EmailSettings` | No | — | Email provider config for verification/reset emails. See [Email Configuration](#email-configuration). |
| `actions` | `SQLAction[]` | No | `[]` | Server-side actions callable via API. See [Actions Guide](actions-guide.md). |
| `version` | `number` | No | — | Schema version number stamped by the CLI on each apply. Don't hand-set — the CLI tracks this across migrations. |
| `_kvTableName` | `string` | No | `'_ddb_internal_kv'` | Internal KV table name used for tokens, rate-limit counters, etc. Rename only if it collides with one of your own tables. Verified in `src/worker/internalKV.ts:7`. |
| `disableTablesEdit` | `boolean` | No | `false` | Reserved field. Present in the schema but not currently consumed by any extension — intended as an admin-panel safety toggle but the wiring has not landed yet. Set to `false` (or omit) until implementation lands. |

---

## Table Definition (TableData)

```typescript
{
    name: 'posts',
    fields: [/* ... */],

    // Optional
    autoSetUid: true,
    extensions: [/* ... */],   // include a 'rules' extension, or set public: true
    public: false,
    triggers: [/* ... */],
    indexes: [/* ... */],
    fullTextSearch: {/* ... */},
    r2Base: 'posts',
    idInR2: false,
    autoDeleteR2Files: true,
    allowMultipleFileRef: false,
    allowWildcard: false,
}
```

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `name` | `string` | Yes | — | Table name. Used in API routes: `/api/v1/table/{name}/`. Must be a valid SQL identifier. |
| `fields` | `TableFieldData[]` | Yes | — | Column definitions. See [Field Definition](#field-definition-tablefielddata). |
| `autoSetUid` | `boolean` | No | `false` | Auto-generate a unique ID for the `record_uid` field on insert. Requires a field with `usage: 'record_uid'` and `type: 'text'`. |
| `extensions` | `TableExtensionData[]` | No | `[]` | Extensions to enable: `auth`, `rules`, `crud`. CRUD is auto-included. Every table needs a `rules` extension or `public: true`, see [Access Control Defaults](#access-control-defaults). |
| `public` | `boolean` | No | `false` | Opt out of default-deny: with `true`, anyone (including unauthenticated requests) can list, view, insert, update and delete rows. Cannot be combined with a `rules` extension. See [Access Control Defaults](#access-control-defaults). |
| `triggers` | `SQLTrigger[]` | No | `[]` | SQL triggers. See [Triggers](#triggers). |
| `indexes` | `SQLIndex[]` | No | `[]` | Database indexes. See [Indexes](#indexes). |
| `fullTextSearch` | `object` | No | — | Full-text search config. See [Full-Text Search](#full-text-search-fts). |
| `r2Base` | `string` | No | — | R2 bucket path prefix for file storage. Required if any field has `type: 'file'`. |
| `idInR2` | `boolean` | No | `false` | Store files under `{r2Base}/{recordId}/` subdirectories in R2. Cannot be used with `allowMultipleFileRef`. Requires a `record_uid` field with `noUpdate: true`. |
| `autoDeleteR2Files` | `boolean` | No | `true` | Automatically delete R2 files when records are deleted. |
| `allowMultipleFileRef` | `boolean` | No | `false` | Allow referencing the same file from multiple records. Cannot be used with `idInR2`. Requires `autoDeleteR2Files: false`. |
| `allowWildcard` | `boolean` | No | `false` | Allow `*` wildcard in select queries. |

---

## Field Definition (TableFieldData)

```typescript
{
    name: 'title',
    type: 'text',
    sqlType: 'text',

    // Optional — constraints
    primary: false,
    autoIncrement: false,
    unique: false,
    notNull: false,
    default: sql`CURRENT_TIMESTAMP`,
    check: sql`json_valid(config)`,
    collate: 'NOCASE',

    // Optional — foreign key
    foreignKey: {
        table: 'users',
        column: 'id',
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    },

    // Optional — API behavior
    usage: 'record_uid',
    noSelect: false,
    noInsert: false,
    noUpdate: false,
}
```

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `name` | `string` | Yes | — | Column name. Must start with a letter or underscore; alphanumeric + underscores only. |
| `type` | `string` | Yes | — | Teenybase field type. Controls API-level behavior. See [Field Types](#field-types). |
| `sqlType` | `string` | Yes | — | SQLite column type. Controls storage. See [SQL Types](#sql-types). |
| `primary` | `boolean` | No | `false` | PRIMARY KEY constraint. |
| `autoIncrement` | `boolean` | No | `false` | AUTOINCREMENT (integer primary keys only). |
| `unique` | `boolean` | No | `false` | UNIQUE constraint. |
| `notNull` | `boolean` | No | `false` | NOT NULL constraint. |
| `default` | `SQLLiteral \| string` | No | — | Default value. Use `sqlValue('text')` for literal values or `sql\`CURRENT_TIMESTAMP\`` for SQL expressions. |
| `check` | `SQLLiteral \| string` | No | — | CHECK constraint. Example: `` sql`json_valid(config)` ``. |
| `collate` | `string` | No | — | Collation. `'BINARY'`, `'NOCASE'`, or `'RTRIM'`. |
| `foreignKey` | `FieldForeignKey` | No | — | Foreign key relation. See below. |
| `usage` | `string` | No | — | Semantic usage that extensions act on. See [Field Usages](#field-usages). |
| `noSelect` | `boolean` | No | `false` | Exclude from API responses for non-admin requests, and from where/rule expressions. Admin requests (service token, Pocket UI viewer/editor) still read it. The auth password hash and salt are hidden from everyone, admins included, whether or not they set `noSelect`. |
| `noInsert` | `boolean` | No | `false` | Cannot be set via API insert. Used for auto-generated fields. |
| `noUpdate` | `boolean` | No | `false` | Cannot be changed via API update. Used for IDs, creation timestamps. |

#### Foreign Key Options

```typescript
foreignKey: {
    table: 'users',       // Referenced table name
    column: 'id',         // Referenced column name
    onDelete: 'CASCADE',  // Action on parent delete
    onUpdate: 'CASCADE',  // Action on parent update
}
```

| Action | Description |
|--------|-------------|
| `'CASCADE'` | Delete/update child rows when parent changes. |
| `'SET NULL'` | Set foreign key to NULL when parent changes. |
| `'SET DEFAULT'` | Set foreign key to default when parent changes. |
| `'RESTRICT'` | Prevent parent change if children exist. |
| `'NO ACTION'` | Same as RESTRICT in SQLite. |

### Field Types

The `type` property controls how teenybase treats the field at the API level — validation, serialization, and extension behavior.

| Type | Description | Compatible sqlTypes |
|------|-------------|---------------------|
| `text` | Plain text string | `text`, `null` |
| `number` | Floating-point number | `integer`, `real` |
| `integer` | Integer number | `integer` |
| `bool` | Boolean (true/false) | `boolean`, `integer` |
| `email` | Email address (validated format) | `text` |
| `url` | URL string | `text` |
| `editor` | Rich text / HTML content | `text` |
| `date` | Date or datetime value | `text`, `timestamp`, `datetime`, `date`, `time` |
| `select` | Enum / dropdown value | `text`, `integer`, `real` |
| `json` | JSON object or array | `text`, `json` |
| `file` | File reference (stored in R2) | `text` |
| `relation` | Foreign key reference | `text`, `integer`, `real` |
| `password` | Password field (hashed) | `text` |
| `blob` | Binary data | `blob` |

### SQL Types

The `sqlType` property maps to the actual SQLite column type used in DDL.

| sqlType | SQLite Affinity | Notes |
|---------|----------------|-------|
| `text` | TEXT | Most common. Strings, JSON, file paths, relations. |
| `integer` | INTEGER | Integers, booleans (0/1). |
| `real` | REAL | Floating-point numbers. |
| `boolean` | NUMERIC | Stored as 0/1 in SQLite. |
| `blob` | BLOB | Binary data. |
| `json` | TEXT | Stored as JSON string. Can use `json_valid()` CHECK constraint. |
| `timestamp` | TEXT | ISO 8601 datetime string. Used with `CURRENT_TIMESTAMP`. |
| `datetime` | TEXT | Alias for timestamp. |
| `date` | TEXT | Date-only string. |
| `time` | TEXT | Time-only string. |
| `float` | REAL | Alias for real. |
| `int` | INTEGER | Alias for integer. |
| `numeric` | NUMERIC | SQLite numeric affinity. |
| `null` | — | NULL type (rare). |

### Field Usages

Usages give fields semantic meaning. Extensions detect usages automatically and wire up behavior — you don't need to write any handler code.

#### Record Usages

| Usage | Description | Auto behavior |
|-------|-------------|---------------|
| `record_uid` | Unique record identifier | Auto-generated on insert (when `autoSetUid: true`). Used as the record's primary identifier in API responses. |
| `record_created` | Creation timestamp | Set to `CURRENT_TIMESTAMP` on insert. Protected from updates via trigger. |
| `record_updated` | Last update timestamp | Set to `CURRENT_TIMESTAMP` on every update via trigger. |

#### Auth Usages

These are recognized by the [Auth Extension](#auth-extension-tableauthextensiondata) and enable automatic authentication behavior.

| Usage | Description | Auto behavior |
|-------|-------------|---------------|
| `auth_email` | User's email address | Used as login identity. Must be unique. |
| `auth_username` | Username | Used as alternative login identity. Must be unique. |
| `auth_password` | Password hash | Automatically hashed on sign-up and on update. Never returned by any select or `returning` and not usable in where/rules, admin requests included. Admins set a new password by updating it (`setValues: {password, passwordConfirm}`). |
| `auth_password_salt` | Password salt | Auto-generated with the hash. Never returned or filterable, like the hash. Admin-only write (see below). |
| `auth_email_verified` | Email verification status | Set to `false` on sign-up. Updated on verification confirm. Admin-only write. |
| `auth_name` | Display name | Included in JWT payload. |
| `auth_avatar` | Profile picture (file) | Stored in R2 via file upload. |
| `auth_audience` | Role / audience | Included in JWT `aud` claim, read as `auth.role` in rules. Admin-only write. |
| `auth_metadata` | User metadata (JSON) | Included in JWT `meta` claim. Flexible key-value storage. Writable by the user if the rules allow. |

**Admin-only auth columns.** A non-admin request cannot write the `auth_audience`, `auth_email_verified` or `auth_password_salt` columns: sign-up, `insert`, `update`, `edit` and action steps that set one get `403` with a field error (`"role can only be set by an admin"`), even when the rules and `noInsert`/`noUpdate` would allow it. New users get the column's `default`, so give `role` a default if every user should start with one (`{...fields.role, default: sqlValue('guest')}`). Admin tokens can set them (promote a user with an admin `update`); action steps with `applyTableRules: false` can too. A non-admin email change (when `email` is not `noUpdate`) is validated like sign-up and resets `email_verified` unless the address is unchanged. See [Security: Privileged auth fields](security.md#privileged-auth-fields).

---

## Extensions

### Auth Extension (TableAuthExtensionData)

Adds authentication endpoints to a table — sign-up, login, password reset, email verification, OAuth, and JWT management.

```typescript
{
    name: 'auth',
    jwtSecret: '$JWT_SECRET_USERS',   // required
    jwtTokenDuration: 3600,           // required (seconds)
    maxTokenRefresh: 5,               // required (0 = unlimited)
} as TableAuthExtensionData
```

**JWT (required):**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `jwtSecret` | `string` | **Required** | Table-level JWT secret. Concatenated with global `jwtSecret` to form the signing key. Use `$` prefix for env vars. |
| `jwtTokenDuration` | `number` | **Required** | JWT access token expiry in seconds. |
| `maxTokenRefresh` | `number` | **Required** | Max refreshes before re-login. Set to `0` for unlimited. |

**Passwords:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `passwordType` | `'sha256'` | `'sha256'` | Password hashing algorithm. Currently only `sha256` supported. |
| `passwordConfirmSuffix` | `string` | — | Suffix for password confirmation field (e.g., `'Confirm'` → `passwordConfirm`). When set, sign-up requires both fields to match. |
| `passwordCurrentSuffix` | `string` | `'Current'` | Suffix for current password field on update (e.g., `passwordCurrent`). Set to `''` to disable (not recommended). |

**Email & verification:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `autoSendVerificationEmail` | `boolean` | `false` | Send verification email on sign-up. Requires email service config. |
| `normalizeEmail` | `boolean` | `true` | Lowercase, trim, punycode domains, provider-specific rules (gmail: remove dots/plus-addressing). |
| `passwordResetTokenDuration` | `number` | `3600` | Reset token validity in seconds. |
| `emailVerifyTokenDuration` | `number` | `3600` | Verification token validity in seconds. |
| `passwordResetEmailDuration` | `number` | `120` | Min interval between reset emails (seconds). |
| `emailVerifyEmailDuration` | `number` | `120` | Min interval between verification emails (seconds). |
| `emailTemplates` | `object` | — | Custom templates for `verification` and `passwordReset`. See below. |

**OAuth:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `saveIdentities` | `boolean` | `false` | Save OAuth provider identity data in `_auth_identities` table. |

#### Email Templates

```typescript
emailTemplates: {
    verification: {
        subject: 'Verify your email',
        layoutHtml: '<div>{{EMAIL_CONTENT}}</div>', // custom inner template (wrapped in base + message layouts)
        variables: { custom_key: 'value' },
        tags: 'verification',
    },
    passwordReset: {
        subject: 'Reset your password',
        layoutHtml: ['<html>{{EMAIL_CONTENT}}</html>', '<div>{{EMAIL_CONTENT}}</div>', '<p>Reset</p>'], // full template stack
    },
}
```

| Property | Type | Description |
|----------|------|-------------|
| `subject` | `string` | Email subject line. Supports `{{variable}}` placeholders. |
| `layoutHtml` | `string \| string[]` | Custom email layout. A full HTML document (starts with `<html` or `<!DOCTYPE`) is used as-is. A fragment string is wrapped in the default base and message layouts. An array of strings replaces the entire template stack — each entry nests into the previous via `{{EMAIL_CONTENT}}`. |
| `variables` | `Record<string, any>` | Additional template variables merged into the email. |
| `tags` | `string` | Tags for email tracking (provider-dependent). |

The default email templates (`baseLayout1`, `messageLayout1`, `actionLinkTemplate`, `actionTextTemplate`) are exported from `teenybase/worker` for use in custom layouts.

**Endpoints added:** See [API Endpoints](api-endpoints.md#authentication)

#### JWT Claims

Auth tokens issued by teenybase contain these claims (defined in `src/types/jwt.ts`):

| Claim | Source field usage | Description |
|-------|-------------------|-------------|
| `id` | `record_uid` | User's unique record ID |
| `sub` | `auth_email` | User's email address |
| `user` | `auth_username` | User's username (note: claim is `user`, not `username`) |
| `aud` | `auth_audience` | User's role(s) — only included if non-empty |
| `verified` | `auth_email_verified` | Whether email is verified — only included if field exists |
| `meta` | `auth_metadata` | Custom metadata (JSON) — only included if field exists |
| `cid` | — | Table name the token was issued for (e.g. `"users"`) |
| `sid` | — | Session ID (for refresh token validation) |
| `iat` | — | Issued at (Unix timestamp) |
| `exp` | — | Expires at (Unix timestamp) |
| `iss` | — | Issuer (from `DatabaseSettings.jwtIssuer`, default `'$db'`) |

**How JWT signing works:** The signing key is `globalJwtSecret + tableJwtSecret` (concatenated). Both resolve `$`-prefixed env vars at runtime.

### Rules Extension (TableRulesExtensionData)

Adds row-level security via expression-based access rules. Rules are compiled to SQL WHERE clauses and injected into every query.

```typescript
{
    name: 'rules',
    listRule: 'auth.uid == owner_id',
    viewRule: 'auth.uid == owner_id',
    createRule: 'auth.uid != null',
    updateRule: 'auth.uid == owner_id',
    deleteRule: 'auth.uid == owner_id',
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `listRule` | `string \| null` | `null` | Filter for list/select queries. Converted to SQL WHERE clause. `null` blocks all access (403). |
| `viewRule` | `string \| null` | `null` | Filter for single-record view. Converted to SQL WHERE clause. `null` blocks all access (403). |
| `createRule` | `string \| null` | `null` | Guard for insert operations. Evaluated against new record values at parse time. `null` blocks all access (403). |
| `updateRule` | `string \| null` | `null` | Filter for update operations. Converted to SQL WHERE clause. `null` blocks all access (403). |
| `deleteRule` | `string \| null` | `null` | Filter for delete operations. Converted to SQL WHERE clause. `null` blocks all access (403). |

Conflict clause `or: 'REPLACE'` (and `edit/:id?or=INSERT`, which uses it) deletes the conflicting row without running `deleteRule`, so on a table with rules it is rejected with 403 for non-admin callers unless `deleteRule` is `'true'` and the table has no trigger on that event (INSERT for inserts, UPDATE for updates; SQLite runs a trigger's own writes with the outer `OR REPLACE` too). On a table with the `auth` extension it is always admin-only, because auth tables don't allow non-admin deletes. `or: 'IGNORE'`, `'ABORT'`, `'FAIL'` and `'ROLLBACK'` are not restricted.

#### Access Control Defaults

Access is **deny by default**, at two levels:

- **A rule that is omitted or `null`** denies that operation (403) to everyone except admins.
- **A table with no `rules` extension at all** behaves as if all five rules were `null`: anonymous and signed-in users get 403 on list, view, insert, update and delete. Admin requests (admin JWT or `ADMIN_SERVICE_TOKEN`) still work, and so do [actions](#actions) that bypass table rules (`sql` mode, or `steps` mode with `applyTableRules: false`; an FK expansion from such a step into another rules-less table is still denied).

Like rules, default-deny governs the CRUD routes (`/api/v1/table/{table}/...`) and rule-applying actions. On an auth table, password sign-up goes through `createRule` (so it is denied too), but login, OAuth sign-in, password reset, email verification and change-password do not use table rules. The `/api/v1/files/...` download route does not check rules either.

Because a table nobody can reach is almost always a mistake, `teeny generate`, `teeny deploy` and `teeny build` **fail** when a table has neither a `rules` extension nor `public: true`:

```
Table "notes" has no access rules.
...
Fix each table in one of two ways:
  1. Add a rules extension that says who can do what, ...
  2. Mark it public, ...
```

Pick one per table:

```typescript
// 1. Rules (recommended). Omitted rules stay null = denied.
{ name: 'notes', fields: [/* ... */], extensions: [
    { name: 'rules', listRule: 'auth.uid == owner_id', viewRule: 'auth.uid == owner_id',
      createRule: 'auth.uid != null & owner_id == auth.uid', updateRule: 'auth.uid == owner_id', deleteRule: 'auth.uid == owner_id' },
] }

// 1b. Admin-only table: a rules extension with no rules.
{ name: 'audit_log', fields: [/* ... */], extensions: [{ name: 'rules' }] }

// 2. Fully public table: anyone, including unauthenticated requests, can read AND write every row.
{ name: 'guestbook', fields: [/* ... */], extensions: [], public: true }
```

`public: true` together with a `rules` extension is a validation error, because it would be unclear which one applies. For a table that should be readable by everyone but writable only by some users, use rules (`listRule: 'true', viewRule: 'true'`, and stricter write rules), not `public`.

> **Upgrading from 0.0.x:** tables without a `rules` extension used to allow full anonymous CRUD. They are now denied, and `teeny generate` / `deploy` stop with the error above until you add rules or `public: true` to each such table. To keep the old behaviour for a table, add `public: true` to it.

#### Rule Values

| Value | Behavior |
|-------|----------|
| `'true'` | Allow all requests, including unauthenticated. |
| `'false'` | Deny all requests. |
| `null` or omitted | Deny all requests (no rule = no access). Admin requests are never filtered by rules. |
| Expression string | Evaluated per request. See below. |

#### Expression Syntax

Rules use a JS-like expression language that compiles to **parameterized** SQL WHERE clauses. All string/number literals in expressions become `?` placeholders with bound values, and column names are validated against the table schema. This means string interpolation in expressions (e.g., `` where: `email == '${userInput}'` ``) is safe — it's the intended ORM-like query pattern, not raw SQL.

**Available variables:**

| Variable | Description |
|----------|-------------|
| `auth.uid` | Authenticated user's ID. `null` if not logged in. |
| `auth.email` | User's email from JWT. |
| `auth.role` | User's role/audience from JWT `aud` claim. |
| `auth.verified` | Whether user's email is verified (boolean). |
| `auth.admin` | Whether user is admin (boolean). |
| `auth.superadmin` | Whether user is superadmin (boolean). |
| `auth.meta` | User metadata from JWT `meta` claim. |
| `auth.jwt` | Raw JWT payload (all claims). |
| Column names | Any column from the current table (e.g., `owner_id`, `published`). In createRule there is no stored row yet, so a column name means the row being inserted, the same as `new.<col>`. |
| `new.*` | New values being inserted/updated (e.g., `new.status`, `new.author_id`). Available in createRule and updateRule only. A column the request leaves out is the value the row will get in createRule (its `default`, or NULL), and the stored value in updateRule (it is not changing). |

**Operators:**

| Operator | SQL Equivalent | Example |
|----------|---------------|---------|
| `==` | `IS` | `auth.uid == id` |
| `!=` | `IS NOT` | `auth.uid != null` |
| `=` | `=` | `role = 'guest'` |
| `>` | `>` | `price > 0` |
| `<` | `<` | `age < 18` |
| `>=` | `>=` | `priority >= 5` |
| `<=` | `<=` | `count <= 100` |
| `~` | `LIKE` | `email ~ '%@example.com'` |
| `!~` | `NOT LIKE` | `role !~ '%admin'` |
| `!` | `NOT` (unary) | `!deleted_at` |
| `&` | `AND` | `auth.uid == id & published == true` |
| `\|` | `OR` | `role == 'admin' \| role == 'editor'` |
| `\|\|` | `\|\|` (concat) | `path ~ (auth.meta.base \|\| '%')` |
| `@@` | `MATCH` (FTS5) | `articles @@ 'search term'` |

**SQL functions** available in expressions:

| Function | Description | Example |
|----------|-------------|---------|
| `lower(x)` | Lowercase | `lower(email) == 'admin@test.com'` |
| `upper(x)` | Uppercase | `upper(status) == 'ACTIVE'` |
| `length(x)` | String length | `length(name) > 3` |
| `substring(x, start, len)` | Substring | `substring(code, 1, 2) == 'US'` |
| `replace(x, from, to)` | Replace | `replace(name, ' ', '-')` |
| `concat(a, b, ...)` | Concatenate | `concat(first, ' ', last)` |
| `count(x)`, `sum(x)` | Aggregates | SELECT/actions only |
| `datetime(x)`, `date(x)`, `time(x)` | Date/time | `date(created) == date('now')` |
| `unixepoch(x)` | Unix timestamp | `unixepoch('now') - unixepoch(created) < 3600` |
| `json_set`, `json_insert`, `json_replace`, `json_patch` | JSON mutation | `json_set(meta, '$.key', 'value')` |
| `json_contains(json, val)` | JSON array membership | `json_contains(tags, 'important')` |

#### Rule Examples

```typescript
// Public read, authenticated write
{
    name: 'rules',
    listRule: 'true',                          // Anyone can list
    viewRule: 'true',                          // Anyone can view
    createRule: 'auth.uid != null',            // Must be logged in to create
    updateRule: 'auth.uid == owner_id',        // Only the owner can update
    deleteRule: 'auth.uid == owner_id',        // Only the owner can delete
}

// Admin-only table
{
    name: 'rules',
    listRule: "auth.role == 'admin'",
    viewRule: "auth.role == 'admin'",
    createRule: "auth.role == 'admin'",
    updateRule: "auth.role == 'admin'",
    deleteRule: "auth.role == 'admin'",
}

// Users can only see/edit their own records
{
    name: 'rules',
    listRule: 'auth.uid == id',
    viewRule: 'auth.uid == id',
    createRule: 'auth.uid == null',                      // Sign-up: only non-authenticated
    updateRule: 'auth.uid == id',                        // role/email_verified stay admin-only regardless
    deleteRule: null,                                    // No one can delete
}

// Posts: the author can edit, but not hand the post to someone else
{
    name: 'rules',
    listRule: 'published == true | auth.uid == author_id',
    viewRule: 'published == true | auth.uid == author_id',
    createRule: 'auth.uid != null & author_id == auth.uid',
    updateRule: 'auth.uid == author_id & new.author_id == author_id',  // omitted author_id = unchanged
    deleteRule: 'auth.uid == author_id',
}
```

`auth.role == 'admin'` is safe to rely on: only admins can write the role column (see [Admin-only auth columns](#auth-usages)), so a user cannot sign up as or promote themselves to `admin`. `auth.meta` is different: the meta column is writable by the user like any other column their rules allow, so if rules read `auth.meta`, guard it in the users table with `updateRule: "auth.uid == id & new.meta == meta"` and a `createRule` that checks `meta`.

**"Unchanged" checks in updateRule:** `new.<col> == <col>` passes when the request doesn't touch the column and fails when it changes it. Use `==` (`IS`, null-safe); with `=` a NULL column never equals itself, so the rule would block every update of rows where it is NULL.

#### Common Mistakes

- **Forgetting `null` denies access.** If you omit a rule, it defaults to `null` (deny all), and a table with no `rules` extension denies everything. This is secure by default, but make sure you set rules for endpoints you want accessible. See [Access Control Defaults](#access-control-defaults).
- **`'true'` must be a string.** Use `'true'` (string), not `true` (boolean). Boolean `true` won't work.
- **Rules on create vs read.** Create rules guard whether the insert can happen. List/view rules filter which records are returned — they don't prevent the query, they limit the results.

### CRUD Extension

Auto-included for every table. Provides REST endpoints for CRUD operations.

```typescript
{ name: 'crud' }
```

No additional configuration. The CRUD extension registers these routes:

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/select` | Query records |
| GET/POST | `/list` | Query records with total count |
| GET | `/view/:id` | Get single record by ID |
| POST | `/insert` | Insert one or more records |
| POST | `/update` | Update records by filter |
| POST | `/edit/:id` | Update a single record by ID |
| POST | `/delete` | Delete records by filter |

See [API Endpoints](api-endpoints.md) for full request/response formats.

### OpenAPI Extension

Auto-generates an OpenAPI 3.1.0 spec from your tables, extensions, and actions.

```typescript
import { OpenApiExtension } from 'teenybase/worker'

db.extensions.push(new OpenApiExtension(db))        // with Swagger UI (default)
db.extensions.push(new OpenApiExtension(db, false))  // JSON spec only, no Swagger UI
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `db` | `$Database` | (required) | The database instance |
| `swagger` | `boolean` | `true` | Enable Swagger UI at `/doc/ui` |

**Routes** (under `/api/v1`):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/doc` | OpenAPI 3.1.0 JSON spec |
| GET | `/api/v1/doc/ui` | Swagger UI (if `swagger` is `true`) |

**Notes:**
- The document title is "Teenybase API" (v1.0.0) — not configurable.
- Routes with incompatible zod schemas (e.g., `superRefine`) are silently skipped with a console warning.
- An `authorization` header parameter is auto-injected into every route's spec.

### PocketUI Extension

Built-in admin panel for browsing tables, viewing/editing records, and managing data.

```typescript
import { PocketUIExtension } from 'teenybase/worker'

db.extensions.push(new PocketUIExtension(db))
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `db` | `$Database` | (required) | The database instance |
| `baseUrl` | `string` | CDN (`https://cdn.jsdelivr.net/npm/@teenybase/pocket-ui@POCKET_UI_VERSION/dist/`) | Where the worker fetches the UI files from; `POCKET_UI_VERSION` is replaced with `uiVersion`. E.g. `http://localhost:4173/` for local PocketUI development |
| `uiVersion` | `string` | `'0.0.5'` | Exact `@teenybase/pocket-ui` npm version. Each teenybase release pins one; pass another exact version to override (avoid `'latest'`, which lets any new publish of that package run in your admin sessions) |

The worker fetches the UI files and serves them from your API's own origin, so the browser only talks to your worker; the worker needs outbound access to jsDelivr. The fallback login page loads Pico CSS 2.1.1 from jsDelivr with Subresource Integrity, and Swagger UI (`/api/v1/doc/ui`) loads `swagger-ui-dist` 5.33.2 from jsDelivr.

**Routes:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/pocket/` | Admin panel UI (proxied from CDN or custom `baseUrl`) |
| GET | `/api/v1/pocket/login` | Login page |
| POST | `/api/v1/pocket/login` | Authenticate with username + password |
| GET | `/api/v1/pocket/logout` | Clear session cookies, redirect to login |

**Environment variables:**

| Variable | Description |
|----------|-------------|
| `POCKET_UI_VIEWER_PASSWORD` | Password for viewer role (read-only). The viewer and editor logins are admin tokens: they read every row and every `noSelect` column, but never password hashes or salts. |
| `POCKET_UI_EDITOR_PASSWORD` | Password for editor role (read + write) |
| `ADMIN_SERVICE_TOKEN` | Also accepted as superadmin password |

**Cookie behavior:**
- Session cookies expire after 1 hour
- `teeny-pocket-ui-access-token` — signed, httpOnly (auth token)
- `teeny-pocket-ui-user-data` — non-httpOnly (user info for the UI frontend)
- `SameSite: Strict`, `Secure` only on HTTPS

---

## Scaffolds

Pre-built field and trigger definitions importable from `teenybase/scaffolds/fields`. These save boilerplate for common table patterns.

```typescript
import { baseFields, authFields, createdTrigger, updatedTrigger } from 'teenybase/scaffolds/fields'
```

### baseFields

Three fields every table should have: a unique ID, creation timestamp, and update timestamp.

| Field | type | sqlType | usage | Constraints |
|-------|------|---------|-------|-------------|
| `id` | `text` | `text` | `record_uid` | `primary`, `notNull`, `noUpdate` |
| `created` | `date` | `timestamp` | `record_created` | `notNull`, `noInsert`, `noUpdate`, default: `CURRENT_TIMESTAMP` |
| `updated` | `date` | `timestamp` | `record_updated` | `notNull`, `noInsert`, `noUpdate`, default: `CURRENT_TIMESTAMP` |

### authFields

Nine fields for user authentication. Add these alongside `baseFields` on your users table.

| Field | type | sqlType | usage | Constraints |
|-------|------|---------|-------|-------------|
| `username` | `text` | `text` | `auth_username` | `notNull`, `unique` |
| `email` | `text` | `text` | `auth_email` | `notNull`, `unique`, `noUpdate` |
| `email_verified` | `bool` | `boolean` | `auth_email_verified` | `notNull`, `noInsert`, `noUpdate`, default: `false` |
| `password` | `text` | `text` | `auth_password` | `notNull`, `noSelect` (hidden from API) |
| `password_salt` | `text` | `text` | `auth_password_salt` | `notNull`, `noSelect`, `noInsert`, `noUpdate` |
| `name` | `text` | `text` | `auth_name` | `notNull` |
| `avatar` | `file` | `text` | `auth_avatar` | — |
| `role` | `text` | `text` | `auth_audience` | — |
| `meta` | `json` | `json` | `auth_metadata` | — |

### createdTrigger / updatedTrigger

SQL triggers for timestamp management. These are optional — they protect against raw SQL bypassing the API's built-in handling.

```typescript
{
    triggers: [createdTrigger, updatedTrigger],
}
```

| Trigger | Fires | Does |
|---------|-------|------|
| `createdTrigger` | BEFORE UPDATE of `created` | Raises an error if the `created` column is changed. Prevents accidental overwrites. |
| `updatedTrigger` | AFTER UPDATE | Sets `updated` to `CURRENT_TIMESTAMP` when a row changes (only if `updated` wasn't already changed in the same operation). |

---

## Indexes

Indexes improve query performance for frequently filtered or sorted columns.

```typescript
{
    name: 'posts',
    fields: [/* ... */],
    indexes: [
        { fields: 'email', unique: true },           // Single column, unique
        { fields: ['status', 'created'] },            // Composite index
        { fields: 'category', where: { q: "status = 'active'" } },  // Partial index
    ],
}
```

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `name` | `string` | No | Auto-generated | Index name. Generated from table and column names if omitted. |
| `unique` | `boolean` | No | `false` | Create a UNIQUE index. |
| `fields` | `string \| string[]` | Yes | — | Column(s) to index. String for single column, array for composite. May include collation (e.g., `'name COLLATE NOCASE'`). |
| `where` | `SQLQuery` | No | — | Partial index condition. Only index rows matching this WHERE clause. Format: `{ q: "sql expression" }`. |

---

## Triggers

Custom SQL triggers that fire on table events. Use for data integrity rules, computed columns, or audit trails.

```typescript
{
    triggers: [
        createdTrigger,                    // From scaffolds
        updatedTrigger,
        {
            name: 'set_deleted_at',
            seq: 'BEFORE',
            event: 'UPDATE',
            updateOf: 'deleted_by',
            body: sql`UPDATE files SET deleted_at = CURRENT_TIMESTAMP
                       WHERE id = NEW.id
                       AND OLD.deleted_by IS NULL
                       AND NEW.deleted_by IS NOT NULL`,
        },
    ],
}
```

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `name` | `string` | Yes | — | Trigger name. Must be unique per table. |
| `seq` | `string` | No | — | Timing: `'BEFORE'`, `'AFTER'`, or `'INSTEAD OF'`. |
| `event` | `string` | Yes | — | Event: `'INSERT'`, `'UPDATE'`, or `'DELETE'`. |
| `updateOf` | `string \| string[]` | No | — | Only fire on UPDATE of specific column(s). Only valid when `event` is `'UPDATE'`. |
| `forEach` | `'ROW'` | No | — | Fire once per affected row (SQLite default behavior). |
| `body` | `SQLQuery \| SQLQuery[]` | Yes | — | SQL to execute. Use `sql\`...\`` tagged template. Access `OLD.*` and `NEW.*` for row values. |
| `when` | `SQLQuery` | No | — | Additional condition. Trigger only fires when this evaluates to true. |

---

## Full-Text Search (FTS)

Built on SQLite FTS5. Enables fast text search across specified columns.

```typescript
{
    name: 'posts',
    fields: [/* ... */],
    fullTextSearch: {
        fields: ['title', 'body'],
        tokenize: 'porter',
        contentless: true,
    },
}
```

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `enabled` | `boolean` | No | `true` | Enable/disable FTS for this table. |
| `fields` | `string[]` | Yes | — | Columns to include in the FTS index. Must exist in the table's `fields`. |
| `tokenize` | `string` | No | — | FTS5 tokenizer. Options: `'unicode61'` (default), `'ascii'`, `'porter'` (stemming), `'trigram'` (substring matching). |
| `prefix` | `string` | No | — | Prefix index sizes for faster prefix queries. E.g., `'2,3'` indexes 2 and 3 character prefixes. |
| `contentless` | `boolean` | No | `true` | Use content table (the actual table) as backing store rather than duplicating data. Saves storage. |
| `content_rowid` | `string` | No | — | Column to use as rowid for the content table. Must be integer type, cannot have a foreign key. |
| `columnsize` | `0 \| 1` | No | — | Store per-column size info. `1` to store (needed for BM25 ranking), `0` to save space. |
| `detail` | `string` | No | `'full'` | Detail level: `'full'` (all positions), `'column'` (column-level only), `'none'` (minimal). Less detail = smaller index. |

---

## Email Configuration

Required for password reset and email verification flows.

```typescript
{
    email: {
        from: 'noreply@example.com',
        variables: {
            company_name: 'My App',
            company_url: 'https://myapp.com',
            company_address: '123 Main St',
            company_copyright: '© 2025 My App',
            support_email: 'support@myapp.com',
        },
        mock: false,

        // Choose one provider:
        mailgun: {
            MAILGUN_API_KEY: '$MAILGUN_API_KEY',
            MAILGUN_API_SERVER: 'api.eu.mailgun.net',
        },
        // — or —
        resend: {
            RESEND_API_KEY: '$RESEND_API_KEY',
        },
        // — or — (no API key; uses a Workers binding)
        cloudflare: {
            // binding: 'EMAIL',  // defaults to 'EMAIL'
        },
    },
}
```

Provider precedence is `mailgun > resend > cloudflare` — if more than one is configured, the first set wins.

| Property | Type | Required | Default | Description |
|----------|------|---------|---------|-------------|
| `from` | `string` | Yes | — | Sender email address. |
| `variables` | `object` | Yes | — | Template variables available in all emails. See below. |
| `mock` | `boolean` | No | `false` | Log emails to console instead of sending. Useful for development. Stores the rendered html/text in the `X-Mock-Email` response header. |
| `tags` | `string[]` | No | — | Email tags for tracking/filtering in your provider. Ignored by Cloudflare (binding has no tag field). |
| `mailgun` | `object` | No | — | Mailgun provider config. |
| `resend` | `object` | No | — | Resend provider config. |
| `cloudflare` | `object` | No | — | Cloudflare Email Service config. Uses a Workers `send_email` binding instead of an API key. See below. |

#### Template Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `company_name` | Yes | Your company/app name. |
| `company_url` | Yes | Your website URL. |
| `company_address` | Yes | Physical address (CAN-SPAM compliance). |
| `company_copyright` | Yes | Copyright line. |
| `support_email` | Yes | Support email for recipients. |

You can add custom key-value pairs — they'll be available in email templates.

#### Mailgun Options

| Property | Required | Description |
|----------|----------|-------------|
| `MAILGUN_API_KEY` | Yes | API key. Prefix with `$` for env var. |
| `MAILGUN_API_SERVER` | Yes | API server (e.g., `'api.eu.mailgun.net'` for EU). |
| `MAILGUN_API_URL` | No | Custom API URL override. |
| `MAILGUN_WEBHOOK_ID` | No | Webhook ID for delivery tracking. |
| `MAILGUN_WEBHOOK_SIGNING_KEY` | No | Webhook signature verification key. |
| `EMAIL_BLOCKLIST` | No | Comma-separated list of blocked email domains. |

#### Resend Options

| Property | Required | Description |
|----------|----------|-------------|
| `RESEND_API_KEY` | Yes | API key. Prefix with `$` for env var. |
| `RESEND_API_URL` | No | Custom API URL override. |
| `RESEND_WEBHOOK_SECRET` | No | Webhook signature secret. |
| `RESEND_WEBHOOK_ID` | No | Webhook ID. |
| `EMAIL_BLOCKLIST` | No | Comma-separated list of blocked email domains. |

#### Cloudflare Options

Cloudflare Email Service uses a Workers binding instead of API keys. Before first use:

1. Onboard the sending domain: `npx wrangler email sending enable yourdomain.com` and follow the DNS-record prompts.
2. Declare the binding in `wrangler.jsonc`:

   ```jsonc
   {
     "send_email": [
       { "name": "EMAIL" }
       // For a dev guardrail, replace the entry above with the restricted form below
       // (don't add it as a second entry — two bindings with the same `name` collide):
       // { "name": "EMAIL", "allowed_destination_addresses": ["you@example.com"] }
     ]
   }
   ```

3. Set `email.cloudflare` in your teenybase config.

| Property | Required | Description |
|----------|----------|-------------|
| `binding` | No | Name of the `send_email` binding declared in `wrangler.jsonc`. Defaults to `'EMAIL'`. |
| `DISCORD_CF_EMAIL_NOTIFY_WEBHOOK` | No | Discord webhook URL for delivery-failure notifications. |
| `EMAIL_BLOCKLIST` | No | Comma-separated list of blocked email domains. |

Notes:
- The Cloudflare binding has no inbound webhook surface; bounce/delivery telemetry would arrive via separate Email Routing handlers.
- Email tags from `email.tags` or per-send `tags` are silently dropped — the binding does not support them.

#### Plain-text body

Built-in templates (verification, password reset) produce both an html and a plain-text body. The plain text is rendered from paired text templates (`*-text.ts`) under `src/worker/email/templates/`, not stripped from html — this keeps the output clean for terminal clients, screen readers, and spam scoring.

Per-call override via the second argument to `sendActionLink`/`sendActionText`:

```ts
// html-only override (legacy form)
await email.sendActionLink({...}, '<table>...</table>')

// override both
await email.sendActionLink({...}, {
    html: '<table>...</table>',
    text: '{{message_title}}\n{{action_text}}: {{action_link}}',
})
```

Config-level override via `emailTemplates.verification.layoutText` / `emailTemplates.passwordReset.layoutText` (sibling to `layoutHtml`) on the `auth` extension config.

If you call `email.sendEmail()` directly, pass `text` alongside `html`.

---

## Actions

Server-side logic callable via `POST /api/v1/action/{name}`. See the [Actions Guide](actions-guide.md) for full documentation with examples.

```typescript
{
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
}
```

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `name` | `string` | Yes | — | Action name. Used in API route: `/api/v1/action/{name}`. |
| `description` | `string` | No | — | Description, shown in OpenAPI docs. Max 1000 characters. |
| `params` | `Record<string, ParamDef>` | No | — | Typed parameters. See [Actions Guide — Parameters](actions-guide.md#parameters). |
| `guard` | `string` | No | — | Expression evaluated before execution. Fails with 403 if false. |
| `requireAuth` | `boolean` | No | `false` | Require authentication. Returns 401 if no valid token. |
| `applyTableRules` | `boolean` | No | `true` | Apply table-level RLS rules in steps mode. |
| `sql` | `object \| object[]` | No* | — | Raw SQL query objects. *Must have either `sql` or `steps`. |
| `steps` | `object \| object[]` | No* | — | Expression-based statements. *Must have either `sql` or `steps`. |

---

## Auth Cookie

Configure cookie-based authentication. When set, teenybase will:

- **Read** the auth token from this cookie in `initAuth()` (on every request, after checking the `Authorization` header)
- **Set** the cookie automatically on OAuth redirect flows (Google One Tap, OAuth callback)
- **Delete** the cookie on logout

> **Note:** JSON endpoints (`login-password`, `sign-up`, `refresh-token`) return the token in the response body but do **not** set a cookie. This is by design — setting `Set-Cookie` on JSON responses breaks CORS with wildcard origins, prevents CDN caching, and causes issues with mobile clients. For SSR routes in your worker, call the auth extension directly (for example, `c.get('$db').table('users').extension('auth').loginWithPassword(...)`) and set the cookie server-side with `setCookie(...)`; do not same-origin `fetch()` your own auth endpoint just to set a cookie.

```typescript
{
    authCookie: {
        name: 'auth_token',
        httpOnly: true,       // default: true — prevents JavaScript access
        secure: true,         // default: true — HTTPS only (set false for local dev)
        sameSite: 'Lax',      // default: 'Lax'
        path: '/',            // default: '/'
        maxAge: 604800,       // optional — cookie lifetime in seconds
        domain: '.example.com', // optional — defaults to current domain
    },
}
```

| Property | Type | Required | Default | Description |
|----------|------|---------|---------|-------------|
| `name` | `string` | Yes | — | Cookie name. |
| `httpOnly` | `boolean` | No | `true` | Prevent JavaScript access. |
| `secure` | `boolean` | No | `true` | Only send over HTTPS. |
| `sameSite` | `string` | No | `'Lax'` | `'Strict'`, `'Lax'`, or `'None'`. |
| `path` | `string` | No | `'/'` | Cookie path. |
| `maxAge` | `number` | No | — | Cookie lifetime in seconds (session cookie if not set). |
| `domain` | `string` | No | — | Cookie domain. |

---

## Auth Providers

Configure external authentication providers — OAuth redirect flows, JWT/Bearer token verification, or both. Use the unified `authProviders` array.

**How it works:**
- **`clientSecret` present** — OAuth redirect flow enabled (authorization code exchange)
- **Known JWKS provider** (e.g., `'google'`, `'supabase'`) **or explicit `jwksUrl`/`secret`** — Bearer token login enabled (via `/auth/login-token`)
- Both can be active on the same provider (e.g., Google supports OAuth redirect AND One Tap bearer tokens)

```typescript
{
    authProviders: [
        // Google (both OAuth redirect + One Tap bearer)
        { name: 'google', clientId: '$GOOGLE_CLIENT_ID', clientSecret: '$GOOGLE_CLIENT_SECRET' },

        // GitHub (OAuth only)
        { name: 'github', clientId: '$GITHUB_CLIENT_ID', clientSecret: '$GITHUB_CLIENT_SECRET' },

        // Supabase (JWT only, JWKS auto-detected)
        { name: 'supabase', issuer: 'https://xyz.supabase.co/auth/v1' },

        // Custom issuer with HMAC secret
        { issuer: 'https://other.example.com', secret: '$OTHER_SECRET' },

        // JWKS URL (Auth0, Clerk, Okta, Keycloak, etc.)
        {
            issuer: 'https://myapp.auth0.com/',
            jwksUrl: 'https://myapp.auth0.com/.well-known/jwks.json',
            algorithm: 'RS256',
            clientId: '$AUTH0_CLIENT_ID',
        },

        // JWK public key object (RS256/ES256)
        {
            issuer: 'https://auth.myservice.com',
            secret: { kty: 'RSA', n: '...', e: 'AQAB' },
            algorithm: 'RS256',
            clientId: 'my-client-id',
        },

        // Custom OAuth provider (fully manual)
        {
            name: 'custom-provider',
            authorizeUrl: 'https://provider.com/oauth/authorize',
            tokenUrl: 'https://provider.com/oauth/token',
            userinfoUrl: 'https://provider.com/api/userinfo',
            clientId: '$CUSTOM_CLIENT_ID',
            clientSecret: '$CUSTOM_CLIENT_SECRET',
            scopes: ['openid', 'email'],
            mapping: { email: 'email_address', avatar: 'photo_url' },
        },

        // Partial mode: Bearer tokens set auth.email and auth.verified (for email-based rules)
        {
            issuer: 'https://internal-service.example.com',
            secret: '$INTERNAL_SERVICE_SECRET',
            bearerMode: 'partial',
        },

        // Cross-instance teenybase: full mode passes through user/session fields (uid, cid, sid, meta)
        {
            issuer: 'https://other-app.example.com',
            secret: '$OTHER_APP_JWT_SECRET',
            bearerMode: 'full',
        },

        // Admin mode: same as full + trusts the admin flag (only for fully trusted instances)
        {
            issuer: 'https://admin-app.example.com',
            secret: '$ADMIN_APP_JWT_SECRET',
            bearerMode: 'admin',
        },
    ],
}
```

#### Provider Properties

| Property | Type | Required | Default | Description |
|----------|------|---------|---------|-------------|
| `name` | `string` | No | — | Provider name. Built-in presets: `'google'`, `'github'`, `'discord'`, `'linkedin'`, `'supabase'`. Any other string uses manual configuration. |
| `issuer` | `string` | No | — | JWT `iss` claim to trust. Required for JWT/Bearer verification when not using a known preset. |
| `clientId` | `string \| string[]` | No | — | OAuth client ID and/or expected JWT `aud`/`azp` claim(s). Prefix with `$` for env var. |
| `clientSecret` | `string` | No | — | OAuth client secret. When present, enables OAuth redirect flow. Always use `$` env var in production. |
| `secret` | `string \| JsonWebKey` | No | — | HMAC shared secret, PEM public key string, or JWK public key object for JWT verification. Strings support `$ENV_VAR` syntax. |
| `jwksUrl` | `string` | No | — | JWKS endpoint URL. Keys are fetched and cached (10 min TTL), matched by `kid` header. |
| `algorithm` | `string` | No | Auto-detected | JWT algorithm. Defaults to `'HS256'` for string secrets, `'RS256'` for JWK/JWKS. Auto-detected from JWK `alg` field when present. |
| `bearerMode` | `'login' \| 'partial' \| 'full' \| 'admin'` | No | `'login'` | Controls Bearer token behavior. `'login'` (default): tokens only work via `/auth/login-token`. `'partial'`: sets auth.email/verified for email-based rules. `'full'`: passes user/session fields (id, cid, sid, meta, aud) for cross-instance auth. `'admin'`: same as full + trusts the admin flag. |
| `scopes` | `string[]` | No | Provider default | OAuth scopes to request. |
| `redirectUrl` | `string` | No | — | Frontend URL to redirect after successful OAuth. |
| `authorizeUrl` | `string` | No | Preset | OAuth authorization endpoint (manual providers only). |
| `tokenUrl` | `string` | No | Preset | Token exchange endpoint. |
| `userinfoUrl` | `string` | No | Preset | Userinfo endpoint for fetching profile data. |
| `userinfoHeaders` | `Record<string, string>` | No | — | Additional headers for userinfo request. |
| `userinfoField` | `string` | No | — | Extract nested field from userinfo response (e.g., `'user'` for Discord). |
| `authorizeParams` | `Record<string, string>` | No | — | Additional query params for authorization URL. |
| `mapping` | `object` | No | Defaults | Map provider fields to teenybase user fields. See below. |
| `trustEmailVerified` | `boolean` | No | `false` | When the provider response omits the verification field, treat the email as verified anyway. Built-in `google` and `linkedin` opt in. For custom providers, set `true` only when you know the provider verifies email at signup. Otherwise the OAuth login is rejected with `400 Email not verified`. See [OAuth Guide → Email Verification Trust](oauth-guide.md#email-verification-trust). |

#### Field Mapping

```typescript
mapping: {
    email: 'email',           // Default: 'email'
    name: 'name',             // Default: 'name'
    username: 'login',        // No default
    avatar: 'picture',        // No default
    verified: 'email_verified', // Default: 'email_verified'
}
```

The `verified` mapping reads a truthy/falsy flag from the provider response. Truthy (`true` / `1` / `'true'`) → user marked verified. Falsy → OAuth login rejected. Missing → falls back to `trustEmailVerified` (default `false` → rejected). See [Email Verification Trust](oauth-guide.md#email-verification-trust).

#### Two ways to provide the JWT verification key:
- **`secret`** — HMAC shared secret string (`$ENV_VAR` supported), PEM public key string, or JWK public key object
- **`jwksUrl`** — JWKS endpoint URL to auto-fetch and cache public keys (standard for Auth0, Clerk, Okta, etc.)

See the [OAuth Guide](oauth-guide.md) for provider-specific setup instructions.

---

## `database`

Selects the backend and carries connection info. Optional — omitting the field is equivalent to `{type: 'd1-binding', binding: 'PRIMARY_DB'}`.

### Shape

| field | type | required when | notes |
|---|---|---|---|
| `type` | `'d1-binding' \| 'libsql' \| 'd1-http' \| 'd1-rest' \| string` | always | Adapter kind. Custom types are allowed; ship your own `*Extension`. |
| `binding` | `string` | `type === 'd1-binding'` | Wrangler D1 binding name (worker env key). |
| `url` | `string` | `type` is `'libsql'` or `'d1-http'` | Endpoint URL. Supports `$VAR_NAME` env interpolation. |
| `authToken` | `string` | optional | Bearer token. Supports `$VAR_NAME`. |
| `cloudflare` | `{accountId, databaseId, apiToken}` | `type === 'd1-rest'` | Cloudflare REST API credentials. Each field supports `$VAR_NAME`. |

### Adapters

> [!WARNING]
> Only `d1-binding` is supported end to end: the CLI (`teeny generate`, `teeny deploy`, `teeny dev`) and the migration flow assume a Cloudflare D1 binding, and teenybase runs only on Cloudflare Workers. `d1-rest`, `libsql` and `d1-http` are experimental, unsupported runtime adapters, only covered by tests against mock servers.

- **`d1-binding`** (built-in, zero-config default) — uses the wrangler D1 binding from the worker env.
- **`d1-rest`** (experimental) — talks to the Cloudflare D1 REST API. Requires the `D1RestExtension` to be imported and registered.
- **`libsql`** (experimental) — a libSQL server over HTTP. Requires the `LibsqlExtension`.
- **`d1-http`** (experimental) — a server exposing a D1-compatible HTTP API. Requires the `D1HttpExtension`.

The non-default adapter extensions (`D1RestExtension`, `LibsqlExtension`, `D1HttpExtension`) are exported from `teenybase/worker` and must be passed to `db.registerExtension()`.

### Example — d1-binding (default)

```ts
database: {type: 'd1-binding', binding: 'PRIMARY_DB'}
```

### Example — libsql (experimental)

```ts
database: {type: 'libsql', url: '$LIBSQL_URL', authToken: '$LIBSQL_TOKEN'}
```

### Example — d1-http (experimental)

```ts
database: {type: 'd1-http', url: '$SQLITE_URL', authToken: '$SQLITE_TOKEN'}
```

### Example — d1-rest

```ts
database: {
    type: 'd1-rest',
    cloudflare: {
        accountId: '$CF_ACCOUNT_ID',
        databaseId: '$D1_DATABASE_ID',
        apiToken: '$CF_D1_EDIT_TOKEN',
    },
}
```

---

## How JWT Signing Works

Teenybase uses a **double-secret** approach for table auth tokens. The actual signing key is the global `jwtSecret` concatenated with the table-level `jwtSecret`:

```
signing_key = global_jwtSecret + table_jwtSecret
```

This means:
- **Changing the global secret** invalidates all tokens across all tables
- **Changing a table's secret** only invalidates that table's tokens
- **Both secrets must be present** for table auth tokens to sign and verify correctly
- **Tokens without a table claim** (e.g. admin tokens) use only the global secret

```typescript
// teenybase.ts
export default {
    jwtSecret: '$JWT_SECRET',           // global — part of every signing key
    tables: [{
        name: 'users',
        extensions: [{
            name: 'auth',
            jwtSecret: '$JWT_SECRET_USERS',  // table — combined with global
            // actual signing key = JWT_SECRET + JWT_SECRET_USERS
        }],
    }],
}
```

Use different `$ENV_VAR` names for the global and each table secret. This way, rotating one table's secret doesn't affect other tables.

---

## Environment Variable Resolution

Any string value prefixed with `$` is resolved from environment variables at runtime. This keeps secrets out of your config file.

```typescript
jwtSecret: '$JWT_SECRET',    // Resolves to the value of JWT_SECRET env var
```

- **Local dev:** Read from `.dev.vars` file in your project root
- **Production:** Read from Cloudflare Worker secrets (upload via `teeny secrets --remote --upload` from `.prod.vars`)

**Example `.dev.vars`:**

```
JWT_SECRET=my-local-dev-secret-change-in-production
GOOGLE_CLIENT_ID=1234567890.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxx
MAILGUN_API_KEY=key-xxxxxxxx
```

---

## Debug Flags (`RESPOND_WITH_ERRORS`, `RESPOND_WITH_QUERY_LOG`)

Two worker vars control how much detail an error response carries. Both are **off unless set to `"true"`** (or `"1"`). An unset var means off.

| Var | When `"true"` | Default |
|-----|---------------|---------|
| `RESPOND_WITH_ERRORS` | Error responses include `data` (the SQLite message, per-column constraint errors, parse-error details), zod `issues`, and raw error messages for non-HTTP errors. Login endpoints also return the real validation error instead of the generic "Invalid username or password". | off |
| `RESPOND_WITH_QUERY_LOG` | Error responses include `queries` (the SQL log of the request). Together with `RESPOND_WITH_ERRORS`, a failed statement also comes back as `data.input`, the rendered SQL. Also enables the admin-only `/explain/*` route used by `teeny exec --explain`. | off |

With both off, a failed request returns only `code` and `message` (plus field-level `data` for zod validation errors and for a taken email/username on sign-up). Generated SQL, bound values and internal error messages stay in the server log (`teeny logs`).

Even with both flags on, literal values written to password hash and salt columns, `noSelect` columns and `password`-type fields are rendered as `'***'` in `data.input` and `queries` (they are still bound to SQLite normally). Values computed by an SQL expression (for example `set: {col: "lower('x')"}`) are not redacted, so keep the flags off wherever real secrets are written.

**Never enable either flag in production.** `teeny init` writes `"RESPOND_WITH_ERRORS": "false"` into `wrangler.jsonc`. To see error details while developing locally, set it in `.dev.vars`, which only `teeny dev` / local mode reads and which overrides `wrangler.jsonc` vars:

```
# .dev.vars (local only)
RESPOND_WITH_ERRORS=true
RESPOND_WITH_QUERY_LOG=true
```

> **Upgrading from 0.0.x:** `RESPOND_WITH_ERRORS` used to default to on when unset, and older scaffolds set it to `"true"` in `wrangler.jsonc`. Error responses also used to include the rendered SQL statement, including the password hash and salt on a failed sign-up. Set `"RESPOND_WITH_ERRORS": "false"` (or remove the var) in your `wrangler.jsonc` and move any `"true"` into `.dev.vars`.

---

## Observability (wrangler.jsonc)

The `observability` block in `wrangler.jsonc` enables Cloudflare Workers Logs — stored for 7 days on paid plans, 3 days on free. Generated by `teeny init` with sensible defaults:

```jsonc
"observability": {
    "enabled": true,
    "logs": {
        "invocation_logs": true,
        "head_sampling_rate": 1
    }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch for Workers Logs |
| `logs.invocation_logs` | boolean | `true` | Log automatic invocation data (request/response metadata) |
| `logs.head_sampling_rate` | number | `1` | Fraction of requests to log (1 = 100%, 0.01 = 1%) |

Stream logs via `teeny logs` (needs `CLOUDFLARE_API_TOKEN`, not just `wrangler login`) — see [CLI Reference](cli.md#logs-name).

> **Note:** This is a wrangler.jsonc setting, not a `teenybase.ts` setting. It controls Cloudflare platform-level logging, not application-level config.

---

[Back to README](../README.md) | [Actions Guide](actions-guide.md) | [API Endpoints](api-endpoints.md) | [Getting Started](getting-started.md)
