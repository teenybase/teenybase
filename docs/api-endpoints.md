# API Endpoints

All endpoints are under `/api/v1/`. Table routes are at `/api/v1/table/{table}/`.

For JavaScript examples of every operation, see the [Frontend Guide](frontend-guide.md). Your running server also has interactive docs at `/api/v1/doc/ui` (Swagger UI).

## Database Level

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/doc` | GET | OpenAPI 3.1.0 JSON spec (requires `OpenApiExtension`; default in `teeny init`) |
| `/doc/ui` | GET | Swagger UI (requires `OpenApiExtension`; default in `teeny init`) |
| `/pocket/` | GET | Admin panel UI (requires `PocketUIExtension`; default in `teeny init`) |
| `/settings` | GET | Database settings (admin) |
| `/setup-db` | POST | Initialize database (superadmin) |
| `/migrations` | GET/POST | List or apply migrations (superadmin) |
| `/files/{table}/{rid}/{path}` | GET | Download file from R2 |
| `/action/{name}` | POST | Execute an action |
| `/auth/logout` | POST | Clear the auth cookie (top-level; distinct from per-table `/table/{t}/auth/logout`) |
| `/explain/*` | GET | Admin dry-run for any API route. Requires admin auth + `RESPOND_WITH_QUERY_LOG` env var enabled. Routes the path under `/explain/` as if executing but in `dryRunMode`, returning `{logs, result}` where `logs` is the captured SQL/storage actions. Used by `teeny exec --explain`. |

## Table CRUD

All CRUD endpoints respect row-level security rules defined in your config.

### INSERT — `POST /table/{t}/insert`

```json
{
  "values": { "title": "Hello", "body": "World" },
  "returning": "*"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `values` | object or object[] | Yes | Field values. Array for batch insert. |
| `returning` | string or string[] | No | Fields to return. `"*"` for all. **Without this, response is empty.** |
| `or` | string | No | Conflict handling: `"IGNORE"`, `"REPLACE"`, `"ABORT"`, `"FAIL"`, `"ROLLBACK"`. `"REPLACE"` is admin-only on tables with rules (see below). |

**Common mistake:** Sending `{"title": "x"}` without the `values` wrapper — this silently fails.

### SELECT — `GET/POST /table/{t}/select`

**GET** with query params:
```
/table/{t}/select?where=published == true&order=-created&limit=10&select=id,title
```

**POST** with JSON body:
```json
{
  "where": "published == true",
  "order": "-created",
  "limit": 10,
  "select": "id,title"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `where` | string | No | Filter expression (e.g., `author_id == 'abc'`, `published == true & title != null`) |
| `order` | string or string[] | No | Sort: `"-created"` (DESC), `"+title"` (ASC), `"created DESC"`. Comma-separated or array for multiple. |
| `sort` | string or string[] | No | Alias for `order` (common API convention) |
| `limit` | number | No | Max records to return |
| `offset` | number | No | Skip N records (pagination) |
| `select` | string or string[] | No | Fields to return: `"id,title,created"` or `["id", "title"]` |
| `distinct` | boolean | No | Deduplicate results |
| `group` | string or string[] | No | Group by fields |

Returns: array of records.

### LIST — `GET/POST /table/{t}/list`

Same parameters as SELECT. Returns `{ items: [...], total: number }`.

### VIEW — `GET /table/{t}/view/{id}`

No body. Returns single record or 404.

Optional query params: `select` (field filter), `where` (additional filter).

### UPDATE — `POST /table/{t}/update`

```json
{
  "where": "author_id == 'abc123'",
  "setValues": { "published": true },
  "returning": "*"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `where` | string | **Yes** | Filter expression — which rows to update |
| `setValues` | object | No | Field→value pairs |
| `set` | object | No | Field→SQL expression pairs (e.g., `{ "count": "count + 1" }`) |
| `returning` | string or string[] | No | Fields to return |
| `or` | string | No | Conflict handling, same values as INSERT. `"REPLACE"` is admin-only on tables with rules. |

**`REPLACE` and rules:** SQLite resolves an `OR REPLACE` conflict (primary key or unique column) by deleting the existing row, and that delete never goes through `deleteRule` or `updateRule`. So on a table with a `rules` extension, a non-admin request that uses `REPLACE` (including EDIT with `or=INSERT`) gets **403**, unless `deleteRule` is `'true'` (no trigger on that event, never on auth tables). Admin requests and `public: true` tables are not affected. For a rule-safe "create or update", see [User Preferences (Upsert)](recipes.md#user-preferences-upsert).

### EDIT — `POST /table/{t}/edit/{id}`

```json
{ "title": "Updated Title" }
```

Body is **bare fields** — NOT wrapped in `setValues`. The endpoint wraps it internally.

| Param | Where | Description |
|-------|-------|-------------|
| Body fields | JSON body | Field→value pairs to update |
| `returning` | Query param | Fields to return (defaults to UID field) |
| `or` | Query param | `"INSERT"`: insert the record with this ID if it doesn't exist, replace it if it does (`INSERT OR REPLACE`). Admin-only on tables with rules unless `deleteRule` is `'true'` (no trigger on that event, never on auth tables) (403 otherwise). |

### DELETE — `POST /table/{t}/delete`

```json
{
  "where": "id == 'abc123'",
  "returning": "*"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `where` | string | **Yes** | Filter expression — which rows to delete |
| `returning` | string or string[] | No | Return deleted records |

## Authentication

Available when a table has the `auth` extension. See the [Frontend Guide](frontend-guide.md) for complete auth flow examples.

### Sign Up — `POST /table/{t}/auth/sign-up`

```json
{
  "username": "testuser",
  "email": "test@example.com",
  "password": "mypassword",
  "passwordConfirm": "mypassword",
  "name": "Test User"
}
```

Body is bare fields matching the auth table schema. Returns `{ token, refresh_token, record }`. `passwordConfirm` is required (and must match) when the auth extension sets `passwordConfirmSuffix: 'Confirm'`, as the `with-auth` scaffold does; without that option, omit it.

### Login — `POST /table/{t}/auth/login-password`

```json
{
  "identity": "test@example.com",
  "password": "mypassword"
}
```

The `identity` field accepts email or username. Returns `{ token, refresh_token, record }`.

### Other Auth Endpoints

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/auth/refresh-token` | POST | `{ "refresh_token": "..." }` + `Authorization` header | Refresh an expired token |
| `/auth/change-password` | POST | `{ "password": "new", "passwordCurrent": "old" }` (plus `passwordConfirm` when `passwordConfirmSuffix` is set) | Change password (requires auth with a verified email). Only the password is written; any other field in the body is ignored. |
| `/auth/request-password-reset` | POST | `{ "email": "..." }` | Request password reset email |
| `/auth/confirm-password-reset` | POST | `{ "token": "...", "password": "new" }` (plus `passwordConfirm` when `passwordConfirmSuffix` is set) | Confirm reset with token. Signs the user in and ends their other sessions. |
| `/auth/request-verification` | POST | `{ "email": "..." }` | Request email verification |
| `/auth/confirm-verification` | POST | `{ "token": "..." }` | Confirm email with token |
| `/auth/login-token` | POST | — (uses `Authorization` header) | Login with external JWT |
| `/auth/google-login` | POST | form-encoded; see [Google One Tap docs](https://developers.google.com/identity/gsi/web/guides/overview) | Google One Tap callback. Verifies the Google credential + CSRF, creates a session. Called by the Google JS library, not by application code. |
| `/auth/oauth/{provider}` | GET | — | Start OAuth flow (Google, GitHub, Discord, LinkedIn) |
| `/auth/oauth/{provider}/callback` | GET | — | OAuth callback |
| `/auth/logout` | POST | — (uses `Authorization` header) | Logout (invalidates session) |

### Authenticated Requests

Add `Authorization: Bearer <token>` header to any request that needs auth context (for rules like `auth.uid == id`).
