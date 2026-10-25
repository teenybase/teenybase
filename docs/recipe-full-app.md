# Recipe: Full CRUD App with Auth

A complete, working example modeled on the [notes sample app](https://github.com/teenybase/notes-sample). Users with sign-up/login, items with public/private visibility, full-text search, file uploads, actions, email templates, OAuth, auth cookies. Copy, rename the items table to your domain, deploy.

## teenybase.ts

```typescript
import {DatabaseSettings, sql, sqlValue, TableAuthExtensionData, TableData, TableRulesExtensionData} from "teenybase"
import {authFields, baseFields, createdTrigger, updatedTrigger} from "teenybase/scaffolds/fields"

const userTable: TableData = {
    name: "users",
    autoSetUid: true,
    fields: [
        ...baseFields,  // id, created, updated
        // username, email, email_verified, password, password_salt, name, avatar, role, meta; every new user starts as 'guest'
        ...authFields.map(f => f.name === 'role' ? {...f, default: sqlValue('guest')} : f),
    ],
    indexes: [{fields: "role COLLATE NOCASE"}],
    extensions: [
        {
            name: "rules",
            // Public profiles: anyone can list non-private users. Admins see all.
            listRule: "(auth.uid == id) | auth.role ~ '%admin' | meta->>'$.pvt'!=true",
            viewRule: "(auth.uid == id) | auth.role ~ '%admin'",
            // Sign-up: anonymous users only. role is admin-only (the auth extension rejects it from non-admin
            // requests), so it gets the default 'guest'; the role check below is a second line of defence.
            createRule: "auth.uid == null & role == 'guest'",
            // Users can update their own profile but not meta (rules elsewhere read auth.meta). Role changes go through
            // the set_user_role action below: a user with role 'admin' is not an admin token, so it can't write role directly.
            updateRule: "(auth.uid == id & new.meta == meta) | auth.role ~ '%admin'",
            // Only admins can delete non-admin users.
            deleteRule: "auth.role ~ '%admin' & role !~ '%admin'",
        } as TableRulesExtensionData,
        {
            name: "auth",
            passwordType: "sha256",
            passwordCurrentSuffix: "Current",     // requires passwordCurrent field on password change
            passwordConfirmSuffix: "Confirm",      // requires passwordConfirm field on sign-up
            jwtSecret: "$JWT_SECRET_USERS",        // required — resolved from env at runtime
            jwtTokenDuration: 3 * 60 * 60,         // required — 3 hours
            maxTokenRefresh: 4,                     // required — total session: 12 hours
            emailTemplates: {
                verification: {
                    variables: {
                        message_title: 'Email Verification',
                        message_description: 'Welcome to {{APP_NAME}}. Click the button below to verify your email address.',
                        message_footer: 'If you did not request this, please ignore this email.',
                        action_text: 'Verify Email',
                        action_link: '{{APP_URL}}#/verify-email/{{TOKEN}}',
                    }
                },
                passwordReset: {
                    variables: {
                        message_title: 'Password Reset',
                        message_description: 'Click the button below to reset the password for your {{APP_NAME}} account.',
                        message_footer: 'If you did not request this, you can safely ignore this email.',
                        action_text: 'Reset Password',
                        action_link: '{{APP_URL}}#/reset-password/{{TOKEN}}',
                    }
                }
            }
        } as TableAuthExtensionData,
    ],
    triggers: [createdTrigger, updatedTrigger],
}

const itemsTable: TableData = {
    name: "notes",  // ← rename to your domain (bookmarks, recipes, tasks, etc.)
    autoSetUid: true,
    fields: [
        ...baseFields,
        {name: "owner_id", type: "relation", sqlType: "text", notNull: true, foreignKey: {table: "users", column: "id"}},
        {name: "title", type: "text", sqlType: "text", notNull: true},
        {name: "content", type: "editor", sqlType: "text", notNull: true},
        {name: "is_public", type: "bool", sqlType: "boolean", notNull: true, default: sqlValue(false)},
        {name: "slug", type: "text", sqlType: "text", unique: true, notNull: true, noUpdate: true},
        {name: "tags", type: "text", sqlType: "text"},
        {name: "meta", type: "json", sqlType: "json"},
        {name: "cover", type: "file", sqlType: "text"},
        {name: "views", type: "number", sqlType: "integer", noUpdate: true, noInsert: true, default: sqlValue(0)},
        {name: "archived", type: "bool", sqlType: "boolean", noInsert: true, default: sqlValue(false)},
        {name: "deleted_at", type: "date", sqlType: "timestamp", noInsert: true, default: sqlValue(null)},
    ],
    fullTextSearch: {
        fields: ["title", "content", "tags"],
        tokenize: "trigram"  // substring matching. Use "porter" for English word stemming.
    },
    indexes: [
        {fields: "owner_id"},
        {fields: "tags COLLATE NOCASE"},
        {fields: "is_public"},
        {fields: "archived"},
        {fields: "deleted_at"},
    ],
    extensions: [
        {
            name: "rules",
            viewRule: "(is_public = true & !deleted_at & !archived) | auth.role ~ '%admin' | (auth.uid != null & owner_id == auth.uid)",
            listRule: "(is_public & !deleted_at & !archived) | auth.role ~ '%admin' | (auth.uid != null & owner_id == auth.uid)",
            createRule: "auth.uid != null & owner_id == auth.uid",
            updateRule: "auth.uid != null & owner_id == auth.uid & new.owner_id == owner_id",
            deleteRule: "auth.role ~ '%admin' | (auth.uid != null & owner_id == auth.uid)",
        } as TableRulesExtensionData,
    ],
    triggers: [createdTrigger, updatedTrigger],
}

export default {
    tables: [userTable, itemsTable],
    appName: "My App",
    appUrl: "https://my-app.your-subdomain.workers.dev", // your deployed worker URL
    jwtSecret: "$JWT_SECRET_MAIN",     // resolved from .prod.vars / .dev.vars

    // OAuth — add client IDs as env vars in .dev.vars / .prod.vars
    authProviders: [
        { name: 'google', clientId: '$GOOGLE_CLIENT_ID' },
    ],

    // Auth cookie — set for SSR frontends that need cookie-based auth
    authCookie: {
        name: 'app_auth',
        httpOnly: true,
        secure: false,   // set true in production (requires HTTPS)
        sameSite: 'Lax',
        path: '/',
    },

    // Actions — server-side logic callable via POST /api/v1/action/{name}
    actions: [
        {
            // Role management by users whose role is admin/superadmin. applyTableRules: false is what lets this
            // write the admin-only role column, so the guard and where clause carry all the access control:
            // nobody becomes superadmin, and only a superadmin can change another admin.
            name: 'set_user_role',
            requireAuth: true,
            applyTableRules: false,
            guard: "auth.role ~ '%admin' & params.role != 'superadmin'",
            params: { user_id: 'string', role: 'string' },
            steps: {
                type: 'UPDATE',
                table: userTable.name,
                set: {role: 'params.role'},
                where: "id == params.user_id & role != 'superadmin' & (role !~ '%admin' | auth.role == 'superadmin')",
            },
        },
        {
            name: 'increment_view',
            description: 'Increment view count for an item by slug.',
            applyTableRules: false,
            params: { slug: 'string' },
            sql: {
                type: 'UPDATE',
                table: itemsTable.name,
                set: {views: sql`views + 1`},
                where: sql`slug = {:slug}`,
            },
        },
    ],

    // Email — for verification and password reset (optional, requires Mailgun, Resend, or Cloudflare Email Service)
    email: {
        from: "App Name <noreply@example.com>",
        variables: {
            company_name: "Company",
            company_copyright: "Company",
            company_address: "Company address",
            support_email: "support@example.com",
            company_url: "https://example.com",
        },
        mailgun: {
            MAILGUN_API_SERVER: "mail.example.com",
            MAILGUN_API_KEY: "$MAILGUN_API_KEY",
        },
        // Alternative: resend: { RESEND_API_KEY: '$RESEND_API_KEY' },
        // Alternative: cloudflare: {},  // uses send_email Workers binding (default name 'EMAIL'); domain must be onboarded via `npx wrangler email sending enable <domain>`
    },
} satisfies DatabaseSettings
```

## src/index.ts (SSR frontend)

The scaffold from `teeny init` already includes `teenyHono`, PocketUI, and OpenAPI. Add a `GET /` route:

```typescript
import { $Database, $Env, OpenApiExtension, PocketUIExtension, D1Adapter, teenyHono } from 'teenybase/worker'
import config from 'virtual:teenybase'

type Env = $Env & { Bindings: CloudflareBindings }

const app = teenyHono<Env>(async (c) => {
    const db = new $Database(c, config, c.env.PRIMARY_DB)
    db.extensions.push(new OpenApiExtension(db, true))
    db.extensions.push(new PocketUIExtension(db))
    return db
})

app.get('/', async (c) => {
    // Query D1 directly for SSR — don't fetch your own worker URL
    const items = await c.env.PRIMARY_DB
        .prepare(`SELECT n.*, u.username FROM notes n
                  LEFT JOIN users u ON n.owner_id = u.id
                  WHERE n.is_public = 1 AND n.deleted_at IS NULL AND n.archived = 0
                  ORDER BY n.created DESC LIMIT 50`)
        .all()
    const rows = items.results || []

    return c.html(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>My App</title>
<style>body{font-family:system-ui;max-width:700px;margin:2rem auto;padding:0 1rem}</style>
</head><body>
<h1>My App</h1>
<div id="items">${rows.map((r: any) => `
  <div style="border-bottom:1px solid #eee;padding:1rem 0">
    <strong>${r.title}</strong> <small>by ${r.username || 'anon'}</small>
    ${r.tags ? '<div>' + r.tags.split(',').map((t: string) => '<code>' + t.trim() + '</code> ').join('') + '</div>' : ''}
  </div>`).join('')}
</div>
</body></html>`)
})

export default app
```

## Deploy

```bash
teeny init --yes           # scaffold project
# edit teenybase.ts and src/index.ts
teeny deploy --remote --yes             # create D1, deploy, migrate
```

## What you get

| URL | What |
|-----|------|
| `/` | SSR frontend |
| `/api/v1/table/{name}/list` | List items |
| `/api/v1/table/{name}/select` | Query items (supports filter, sort, limit) |
| `/api/v1/table/{name}/insert` | Create item (`{"values": {...}}`) |
| `/api/v1/table/{name}/update` | Update item |
| `/api/v1/table/{name}/delete` | Delete item |
| `/api/v1/table/users/auth/sign-up` | Sign up |
| `/api/v1/table/users/auth/login-password` | Login |
| `/api/v1/table/users/auth/refresh-token` | Refresh JWT |
| `/api/v1/action/increment_view` | Run action |
| `/api/v1/pocket/` | Admin panel (viewer/editor passwords in .prod.vars) |
| `/api/v1/doc/ui` | OpenAPI/Swagger docs |

## Key things to know

- **`baseFields`**: `id`, `created`, `updated`
- **`authFields`**: `username`, `email`, `email_verified`, `password`, `password_salt`, `name`, `avatar`, `role`, `meta`
- **Auth extension requires**: `jwtSecret`, `jwtTokenDuration`, `maxTokenRefresh` — all three mandatory
- **Users `createRule`**: must allow anonymous insert for sign-up to work. Use `'true'` for simple apps, or `"auth.uid == null"` to allow sign-up only when logged out.
- **`role`, `email_verified`, `password_salt` are admin-only**: a non-admin request that sets them gets 403, so users can't sign up as or promote themselves to admin. New users get the field `default`; change roles with an admin token or an `applyTableRules: false` action with a guard (like `set_user_role`). See [Security: Privileged auth fields](security.md#privileged-auth-fields).
- **`new.*` in rules**: the incoming value (e.g., `new.owner_id`). When the request leaves the column out it is the default in createRule and the stored value in updateRule, so `new.owner_id == owner_id` means "owner unchanged"
- **SSR queries**: use `c.env.PRIMARY_DB.prepare(...)` directly — don't fetch your own worker URL
- **Insert format**: `POST /api/v1/table/{name}/insert` with `{"values": {...}}` — bare `{"title":"x"}` silently fails
- **Select order**: use `-created` or `created DESC` for descending, `created` or `created ASC` for ascending
- **Login field**: use `email`, `username`, or `identity` in `POST /api/v1/table/users/auth/login-password`
- **`$` prefix**: values like `$JWT_SECRET_MAIN` are resolved from environment variables at runtime
- **PocketUI**: auto-generated passwords in `.prod.vars` (`POCKET_UI_VIEWER_PASSWORD`, `POCKET_UI_EDITOR_PASSWORD`)
- **Secrets auto-generated**: on first deploy, JWT secrets + admin token + PocketUI passwords are generated in `.prod.vars`
- **`TEENY_AUTO_CREATE`**: placeholder in `database_id` — CLI creates the D1 database automatically before deploy

---

**See also:** [Getting Started](getting-started.md) | [Configuration Reference](config-reference.md) | [CLI Reference](cli.md) | [Recipes](recipes.md) | [Troubleshooting](troubleshooting.md)
