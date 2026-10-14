# Connecting Your Frontend

> How to call your teenybase API from any frontend — React, Vue, Svelte, vanilla JS, or mobile.

Teenybase exposes a standard REST API. No SDK needed — use `fetch` or any HTTP client.

<!-- TODO: Add screenshot of Swagger UI showing available endpoints -->

---

## Base URL

- **Local development:** `http://localhost:8787/api/v1`
- **Deployed:** your Cloudflare Workers URL + `/api/v1`

```javascript
const API = 'http://localhost:8787/api/v1'
```

---

## Authentication Flow

### 1. Sign Up

```javascript
const response = await fetch(`${API}/table/users/auth/sign-up`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        username: 'alice',
        email: 'alice@example.com',
        password: 'securepassword',
        passwordConfirm: 'securepassword', // required when the auth extension sets passwordConfirmSuffix: 'Confirm' (the with-auth scaffold does)
        name: 'Alice',
    }),
})

const { token, refresh_token, record } = await response.json()
// Store both token and refresh_token
```

**Response:**

```json
{
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "refresh_token": "a1b2c3d4e5f6g7h8i9j0kl",
    "record": {
        "id": "abc123",
        "username": "alice",
        "email": "alice@example.com",
        "name": "Alice",
        "email_verified": false,
        "role": null,
        "avatar": null,
        "meta": null,
        "created": "2025-03-11T10:00:00.000Z",
        "updated": "2025-03-11T10:00:00.000Z"
    },
    "verified": false
}
```

**Email or username already taken** (400), with the field named in `data` so a form can show it on the right input:

```json
{
    "code": 400,
    "message": "An account with this email already exists",
    "data": { "email": { "_errors": ["An account with this email already exists"] } }
}
```

The username case returns `"This username is already taken"` under `data.username`. These field errors are returned with the default settings (no debug flags needed).

### 2. Login

```javascript
const response = await fetch(`${API}/table/users/auth/login-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        identity: 'alice@example.com',  // email or username
        password: 'securepassword',
    }),
})

const { token, refresh_token, record } = await response.json()
```

### 3. Making Authenticated Requests

Include the JWT token in the `Authorization` header:

```javascript
const response = await fetch(`${API}/table/posts/select`, {
    headers: { 'Authorization': `Bearer ${token}` },
})

const posts = await response.json()
```

The `X-Authorization` header also works as an alternative.

### 4. Refreshing Tokens

Tokens expire after `jwtTokenDuration` seconds (default: 1 hour). Use the refresh token to get a new pair without re-entering credentials.

```javascript
const response = await fetch(`${API}/table/users/auth/refresh-token`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,     // Current (possibly expired) token
    },
    body: JSON.stringify({
        refresh_token: refreshToken,             // The refresh token from login/sign-up
    }),
})

const { token: newToken, refresh_token: newRefreshToken, record } = await response.json()
// Replace stored tokens with new ones
```

**Key details:**
- Each token can be refreshed up to `maxTokenRefresh` times (default: 5)
- After that limit, the user must login again
- The refresh token is a 22-character string, different from the JWT

### 5. Change Password

```javascript
const response = await fetch(`${API}/table/users/auth/change-password`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
        passwordCurrent: 'oldpassword',
        password: 'newpassword',
    }),
})
```

This invalidates all other sessions for the user.

### 6. Password Reset (Forgot Password)

Two-step flow: request a reset email, then confirm with the token from the email.

```javascript
// Step 1: Request reset email
await fetch(`${API}/table/users/auth/request-password-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com' }),
})

// Step 2: Confirm reset (user clicks link in email, your frontend extracts the token)
const response = await fetch(`${API}/table/users/auth/confirm-password-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        token: 'RESET_TOKEN_FROM_EMAIL',
        password: 'newpassword',
        passwordConfirm: 'newpassword', // required when passwordConfirmSuffix is set (the with-auth scaffold sets 'Confirm')
    }),
})

const { token, refresh_token, record } = await response.json()
// User is now logged in with new credentials
```

### 7. Email Verification

```javascript
// Request verification email (must be authenticated)
await fetch(`${API}/table/users/auth/request-verification`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
})

// Confirm verification (user clicks link in email)
const response = await fetch(`${API}/table/users/auth/confirm-verification`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        token: 'VERIFICATION_TOKEN_FROM_EMAIL',
    }),
})
```

### 8. Logout

```javascript
await fetch(`${API}/table/users/auth/logout`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
})
// Clear stored tokens
```

---

## CRUD Operations

All CRUD endpoints are at `/api/v1/table/{tableName}/`. Most accept both GET (query params) and POST (JSON body).

### List Records (with Count)

Returns items and total count — useful for pagination.

```javascript
// GET — simple queries
const response = await fetch(
    `${API}/table/posts/list?limit=10&offset=0&order=created DESC`
)

// POST — complex queries
const response = await fetch(`${API}/table/posts/list`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
        where: "published == true & category == 'tech'",
        limit: 10,
        offset: 0,
        order: 'created DESC',
        select: 'id,title,created',
    }),
})

const { items, total } = await response.json()
// items: [{id, title, created}, ...]
// total: 42
```

### Select Records (without Count)

Same as list, but returns a flat array without the total count. Faster for cases where you don't need pagination info.

```javascript
const response = await fetch(`${API}/table/posts/select`, {
    headers: { 'Authorization': `Bearer ${token}` },
})

const posts = await response.json()
// [{id, title, body, ...}, ...]
```

### View Single Record

```javascript
const response = await fetch(`${API}/table/posts/view/${postId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
})

const post = await response.json()
// {id, title, body, published, created, ...}
```

### Insert

```javascript
// Single record
const response = await fetch(`${API}/table/posts/insert`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
        values: {
            title: 'My First Post',
            body: 'Hello world',
            published: true,
        },
    }),
})

const [inserted] = await response.json()

// Batch insert
const response = await fetch(`${API}/table/posts/insert`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
        values: [
            { title: 'Post 1', body: 'Content 1' },
            { title: 'Post 2', body: 'Content 2' },
        ],
        returning: ['id', 'title'],     // Optional: specify which fields to return
    }),
})
```

**Conflict handling:** Add `or` to control behavior when a unique constraint is violated:

```javascript
body: JSON.stringify({
    values: { email: 'alice@example.com', name: 'Alice' },
    or: 'IGNORE',    // ABORT | FAIL | IGNORE | REPLACE | ROLLBACK
})
```

`REPLACE` deletes the conflicting row without checking `deleteRule`, so on a table with rules it is admin-only (403 for users) unless `deleteRule` is `'true'` (no trigger on that event, never on auth tables).

### Update (by Filter)

Update multiple records matching a filter expression.

```javascript
const response = await fetch(`${API}/table/posts/update`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
        where: "author_id == 'abc123' & published == false",
        setValues: {
            published: true,
            updated_by: 'abc123',
        },
        returning: ['id', 'title'],
    }),
})

const updatedPosts = await response.json()
```

You can also use SQL expressions with `set` (instead of `setValues`):

```javascript
body: JSON.stringify({
    where: "id == 'post123'",
    set: { view_count: 'view_count + 1' },    // SQL expression
})
```

### Edit (by ID)

Update a single record by its ID. Simpler than update-by-filter for single record changes. The body is the bare field values (not wrapped in `setValues`).

```javascript
const response = await fetch(`${API}/table/posts/edit/${postId}`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
        title: 'Updated Title',
        body: 'Updated content',
    }),
})

const updatedPost = await response.json()
```

**Insert or replace by ID:** Add `?or=INSERT` to insert the record if the ID doesn't exist and replace it if it does:

```javascript
const response = await fetch(`${API}/table/settings/edit/app_defaults?or=INSERT`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ theme: 'dark', language: 'en' }),
})
```

This runs `INSERT OR REPLACE`, which can delete an existing row without checking `deleteRule`. On a table with rules it is therefore admin-only (403 for users) unless `deleteRule` is `'true'` (no trigger on that event, never on auth tables). For per-user "create or update", use `insert` with `or: 'IGNORE'` and then `update`; see [User Preferences (Upsert)](recipes.md#user-preferences-upsert).

### Delete

```javascript
const response = await fetch(`${API}/table/posts/delete`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
        where: "id == 'post123'",
        returning: ['id', 'title'],     // Optional: return deleted records
    }),
})

const deletedPosts = await response.json()
```

---

## File Uploads

Fields with `type: 'file'` accept file uploads via `multipart/form-data`.

### Uploading a File

```javascript
const formData = new FormData()

// Add the file
formData.append('@filePayload', fileInput.files[0])

// Add the JSON payload referencing the file
formData.append('@jsonPayload', JSON.stringify({
    values: {
        name: 'My Photo',
        avatar: '@filePayload.0',      // References first file in @filePayload
    },
}))

const response = await fetch(`${API}/table/users/insert`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    // Don't set Content-Type — browser sets it with boundary
    body: formData,
})
```

### Uploading Multiple Files

```javascript
const formData = new FormData()

formData.append('@filePayload', file1)
formData.append('@filePayload', file2)

formData.append('@jsonPayload', JSON.stringify({
    values: {
        name: 'Document Set',
        thumbnail: '@filePayload.0',     // First file
        document: '@filePayload.1',      // Second file
    },
}))
```

### Downloading Files

Files are served at:

```
GET /api/v1/files/{table}/{recordId}/{field}
```

```javascript
// Get the file URL from a record
const fileUrl = `${API.replace('/api/v1', '')}/api/v1/files/users/${record.id}/avatar`

// Use in an <img> tag
<img src={fileUrl} alt="Avatar" />
```

---

## Query Parameters

These parameters work on `/select` and `/list` endpoints, both as GET query params and POST body fields.

### where (Filtering)

Filter records using expression syntax. Same operators as [rule expressions](config-reference.md#expression-syntax).

```javascript
// Simple equality
where: "published == true"

// Multiple conditions (AND)
where: "published == true & category == 'tech'"

// OR conditions
where: "status == 'active' | status == 'pending'"

// LIKE pattern matching
where: "title ~ '%javascript%'"

// Comparison
where: "price > 10 & price <= 100"

// Check for null
where: "deleted_at == null"
```

### order (Sorting)

```javascript
// Single field, descending
order: "created DESC"

// Multiple fields
order: ["created DESC", "title"]    // or as string: "-created,title"

// Using +/- prefix shorthand
order: ["-created", "+title"]       // - = DESC, + = ASC
```

### limit / offset (Pagination)

```javascript
// Page 1: first 20 records
{ limit: 20, offset: 0 }

// Page 2: next 20 records
{ limit: 20, offset: 20 }
```

### select (Field Selection)

Return only specific fields to reduce response size.

```javascript
// Comma-separated string
select: "id,title,created"

// Array
select: ["id", "title", "created"]

// All fields (default)
select: "*"
```

### distinct

Return only unique rows.

```javascript
{ distinct: true, select: "category" }
```

### group (Grouping)

Group results by field(s). Useful with aggregate functions in select.

```javascript
{
    select: "category, COUNT(*) as count",
    group: "category",
    order: "count DESC",
}
```

---

## Error Handling

All errors follow a consistent JSON format.

### Error Response Format

```json
{
    "code": 400,
    "message": "Validation Error",
    "data": {
        "title": { "_errors": ["Required"] }
    }
}
```

### Common Status Codes

| Status | Meaning | When |
|--------|---------|------|
| 400 | Bad Request | Invalid input, validation errors, malformed JSON |
| 401 | Unauthorized | Missing or expired auth token |
| 403 | Forbidden | Valid token but insufficient permissions (rule denied) |
| 404 | Not Found | Record or endpoint doesn't exist |
| 409 | Conflict | Duplicate key violation (with FAIL conflict strategy) |
| 500 | Server Error | Internal error |

### Handling Errors in Code

```javascript
async function apiCall(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(token && { 'Authorization': `Bearer ${token}` }),
            ...options.headers,
        },
    })

    if (!response.ok) {
        const error = await response.json()

        if (response.status === 401) {
            // Token expired — try refreshing
            const refreshed = await refreshAuth()
            if (refreshed) return apiCall(url, options)  // Retry
            // Redirect to login
        }

        throw new Error(error.message || 'API error')
    }

    return response.json()
}
```

---

## CORS

Teenybase includes permissive CORS defaults suitable for development and most production setups:

| Header | Default Value |
|--------|--------------|
| `Access-Control-Allow-Origin` | `*` |
| `Access-Control-Allow-Methods` | `POST, GET, OPTIONS, PUT, DELETE, PATCH` |
| `Access-Control-Allow-Headers` | `*` |
| `Access-Control-Expose-Headers` | `*` |
| `Access-Control-Max-Age` | `600` (10 minutes) |
| `Access-Control-Allow-Credentials` | `true` |

Preflight (`OPTIONS`) requests are handled automatically.

> **Note:** If you're using `authCookie` with `sameSite: 'None'`, make sure your frontend and backend are on HTTPS in production. Browsers block cross-site cookies over HTTP.

---

## OAuth from Frontend

### Starting the OAuth Flow

Redirect the user to the OAuth authorization endpoint:

```javascript
// Redirect to Google OAuth
window.location.href = `${API}/table/users/auth/oauth/google?redirect=${encodeURIComponent(window.location.origin + '/auth/callback')}`
```

The `redirect` query parameter tells teenybase where to send the user after authentication. Relative paths are resolved against `appUrl`. By default, only URLs matching the `appUrl` hostname are allowed — configure `allowedRedirectUrls` for other domains. See [OAuth Guide — Redirect URL validation](oauth-guide.md) for details.

If `authCookie` is configured, the auth token will be set as a cookie. Otherwise, you'll need to extract it from the callback.

### Handling the Callback

Your frontend callback page receives the user after OAuth completes:

```javascript
// /auth/callback page
// If using authCookie, the token is already in the cookie
// If not, check for token in URL params or make a request

// With auth cookie — just verify it works
const response = await fetch(`${API}/table/users/select`, {
    credentials: 'include',     // Send cookies
})
const [user] = await response.json()
```

### Supported Providers

Built-in presets: **Google**, **GitHub**, **Discord**, **LinkedIn**. Any OAuth 2.0 provider can be configured manually.

See the [OAuth Guide](oauth-guide.md) for provider-specific setup.

### Google One Tap

If you've configured Google in `authProviders`, you can use Google One Tap for passwordless login:

```html
<!-- Add to your HTML -->
<div id="g_id_onload"
     data-client_id="YOUR_GOOGLE_CLIENT_ID"
     data-login_uri="YOUR_API_URL/table/users/auth/google-login"
     data-auto_prompt="true">
</div>
<script src="https://accounts.google.com/gsi/client" async></script>
```

The form POSTs to `/table/users/auth/google-login` with the Google JWT credential. Teenybase verifies it against Google's public keys and returns a teenybase JWT.

---

## Calling Actions

Actions are server-side logic defined in your config. Call them via POST:

```javascript
const response = await fetch(`${API}/action/increment_counter`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ amount: 5 }),
})

const result = await response.json()
// [[{ id: 1, value: 15 }]]    — array of arrays (one per query)
```

See the [Actions Guide](actions-guide.md) for how to define actions.

---

## Framework Examples

### React

A minimal auth + CRUD hook pattern:

```javascript
// useTeeny.js
import { useState, useCallback } from 'react'

const API = 'http://localhost:8787/api/v1'

export function useTeeny() {
    const [token, setToken] = useState(() => localStorage.getItem('token'))

    const headers = useCallback(() => ({
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` }),
    }), [token])

    const login = async (identity, password) => {
        const res = await fetch(`${API}/table/users/auth/login-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identity, password }),
        })
        const data = await res.json()
        if (res.ok) {
            localStorage.setItem('token', data.token)
            localStorage.setItem('refresh_token', data.refresh_token)
            setToken(data.token)
        }
        return data
    }

    const list = async (table, params = {}) => {
        const res = await fetch(`${API}/table/${table}/list`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(params),
        })
        return res.json()
    }

    const insert = async (table, values) => {
        const res = await fetch(`${API}/table/${table}/insert`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ values }),
        })
        return res.json()
    }

    return { token, login, list, insert }
}
```

```jsx
// App.jsx
function Posts() {
    const { list } = useTeeny()
    const [posts, setPosts] = useState([])

    useEffect(() => {
        list('posts', { order: 'created DESC', limit: 10 })
            .then(data => setPosts(data.items))
    }, [])

    return posts.map(p => <div key={p.id}>{p.title}</div>)
}
```

### Vue

```javascript
// composables/useTeeny.js
import { ref, computed } from 'vue'

const API = 'http://localhost:8787/api/v1'
const token = ref(localStorage.getItem('token'))

export function useTeeny() {
    const headers = computed(() => ({
        'Content-Type': 'application/json',
        ...(token.value && { 'Authorization': `Bearer ${token.value}` }),
    }))

    async function login(identity, password) {
        const res = await fetch(`${API}/table/users/auth/login-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identity, password }),
        })
        const data = await res.json()
        if (res.ok) {
            token.value = data.token
            localStorage.setItem('token', data.token)
            localStorage.setItem('refresh_token', data.refresh_token)
        }
        return data
    }

    async function list(table, params = {}) {
        const res = await fetch(`${API}/table/${table}/list`, {
            method: 'POST',
            headers: headers.value,
            body: JSON.stringify(params),
        })
        return res.json()
    }

    return { token, login, list }
}
```

### Vanilla JS

```javascript
// teeny.js — minimal fetch wrapper
class Teeny {
    constructor(baseUrl) {
        this.baseUrl = baseUrl
        this.token = localStorage.getItem('token')
    }

    get headers() {
        return {
            'Content-Type': 'application/json',
            ...(this.token && { 'Authorization': `Bearer ${this.token}` }),
        }
    }

    async login(identity, password) {
        const res = await fetch(`${this.baseUrl}/table/users/auth/login-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identity, password }),
        })
        const data = await res.json()
        if (res.ok) {
            this.token = data.token
            localStorage.setItem('token', data.token)
            localStorage.setItem('refresh_token', data.refresh_token)
        }
        return data
    }

    async list(table, params = {}) {
        const res = await fetch(`${this.baseUrl}/table/${table}/list`, {
            method: 'POST', headers: this.headers,
            body: JSON.stringify(params),
        })
        return res.json()
    }

    async insert(table, values) {
        const res = await fetch(`${this.baseUrl}/table/${table}/insert`, {
            method: 'POST', headers: this.headers,
            body: JSON.stringify({ values }),
        })
        return res.json()
    }

    async edit(table, id, values) {
        const res = await fetch(`${this.baseUrl}/table/${table}/edit/${id}`, {
            method: 'POST', headers: this.headers,
            body: JSON.stringify(values),
        })
        return res.json()
    }

    async remove(table, where) {
        const res = await fetch(`${this.baseUrl}/table/${table}/delete`, {
            method: 'POST', headers: this.headers,
            body: JSON.stringify({ where }),
        })
        return res.json()
    }
}

// Usage
const tb = new Teeny('http://localhost:8787/api/v1')
await tb.login('alice@example.com', 'password')
const { items } = await tb.list('posts', { limit: 10, order: 'created DESC' })
```

---

## Tips

- **SPA clients:** Store tokens in `localStorage` and pass via `Authorization: Bearer` header.
- **SSR apps:** Set an `httpOnly` cookie server-side after login, and configure [`authCookie`](config-reference.md#auth-cookie) so teenybase reads it on each request. See the [notes-sample](https://github.com/repalash/teeny-notes-sample) for a working example.
- **Mobile apps:** Use secure storage (Keychain/Keystore). Ignore `Set-Cookie` headers — use Bearer tokens.
- **Build a fetch wrapper** that auto-attaches the `Authorization` header and handles 401 → refresh → retry.
- **Use the OpenAPI spec** at `/api/v1/doc` to auto-generate typed clients with tools like `openapi-typescript-codegen`.
- **Swagger UI** is available at `/api/v1/doc/ui` — use it to explore and test endpoints interactively.

<!-- TODO: Add screenshot of Swagger UI at /api/v1/doc/ui -->

---

[Back to README](../README.md) | [API Endpoints](api-endpoints.md) | [Getting Started](getting-started.md)
