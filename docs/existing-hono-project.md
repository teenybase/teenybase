# Adding Teenybase to an Existing Hono + Cloudflare Workers Project

This guide walks through integrating Teenybase into a project that already uses Hono on Cloudflare Workers. By the end, you will have a working backend with auth, CRUD, row-level security, an admin panel, and auto-generated migrations — all driven by a single config file.

> **Tip:** You can also run `npx teenybase init` inside your existing project directory to auto-detect what's already set up and generate only the missing files (teenybase.ts, .dev.vars, etc.). This guide covers manual setup for full understanding.

## Prerequisites

- An existing Hono project deployed on Cloudflare Workers
- Node.js 22 or newer
- Wrangler CLI installed

## 1. Install Teenybase

```bash
npm install teenybase
```

## 2. Pick a D1 Database

No need to create one by hand. With `"database_id": "TEENY_AUTO_CREATE"` (next step), the first `teeny deploy --remote` creates a D1 database named `database_name` in your Cloudflare account and writes its id into `wrangler.jsonc`. If you already have a D1 database, put its id there instead.

## 3. Configure Wrangler Bindings

Add the D1 database binding to your `wrangler.jsonc` (or `wrangler.toml`):

```jsonc
{
    "d1_databases": [
        {
            "binding": "PRIMARY_DB",
            "database_name": "<your-database-name>",
            "database_id": "TEENY_AUTO_CREATE",  // or the id of an existing D1 database
            "migrations_dir": "migrations"
        }
    ],
    "vars": {
        "RESPOND_WITH_ERRORS": "false"  // "true" adds internal error details to responses. Keep "false" here; opt in locally via .dev.vars
    }
}
```

Enable Cloudflare Workers Logs for log streaming with `teeny logs` (which needs `CLOUDFLARE_API_TOKEN`; see [CLI Reference](cli.md#logs-name)):

```jsonc
{
    "observability": {
        "enabled": true,
        "logs": {
            "invocation_logs": true,
            "head_sampling_rate": 1
        }
    }
}
```

If you need file storage (e.g., for user avatars), also add an R2 bucket binding:

```jsonc
{
    "r2_buckets": [
        {
            "binding": "PRIMARY_R2",
            "bucket_name": "<your-bucket-name>"
        }
    ]
}
```

After updating bindings, regenerate your type definitions:

```bash
npx wrangler types --env-interface CloudflareBindings
```

This updates `worker-configuration.d.ts` to include `PRIMARY_DB: D1Database` (and `PRIMARY_R2: R2Bucket` if applicable).

## 4. Create the Database Config

Create `teenybase.ts` (or `teeny.config.ts`) in the project root. This single file defines your entire backend schema, auth, and access rules:

```ts
// teenybase.ts
import { DatabaseSettings, TableAuthExtensionData, TableRulesExtensionData } from "teenybase"
import { baseFields, authFields, createdTrigger } from "teenybase/scaffolds/fields"

export default {
    appName: "My App",
    appUrl: "https://myapp.com",
    jwtSecret: "$JWT_SECRET_MAIN",

    // Optional: allow external auth providers (e.g., Google OAuth + One Tap)
    authProviders: [
        { name: 'google', clientId: '$GOOGLE_CLIENT_ID' },
    ],

    tables: [
        // Users table with authentication
        {
            name: "users",
            autoSetUid: true,
            fields: [
                ...baseFields,   // id, created, updated
                ...authFields,   // username, email, password, etc.
            ],
            triggers: [createdTrigger],
            extensions: [
                {
                    name: "auth",
                    jwtSecret: "$JWT_SECRET_USERS",
                    jwtTokenDuration: 3600,
                    maxTokenRefresh: 5,
                } as TableAuthExtensionData,
                {
                    name: "rules",
                    listRule: "auth.uid == id",
                    viewRule: "auth.uid == id",
                    createRule: "true",
                    updateRule: "auth.uid == id",
                    deleteRule: "auth.uid == id",
                } as TableRulesExtensionData,
            ],
        },

        // Example: Items table owned by users
        {
            name: "items",
            autoSetUid: true,
            fields: [
                ...baseFields,
                {
                    name: "owner_id", type: "relation", sqlType: "text", notNull: true,
                    foreignKey: { table: "users", column: "id" },
                },
                { name: "title", type: "text", sqlType: "text", notNull: true },
                { name: "content", type: "text", sqlType: "text" },
            ],
            triggers: [createdTrigger],
            extensions: [
                {
                    name: "rules",
                    listRule: "auth.uid == owner_id",
                    viewRule: "auth.uid == owner_id",
                    createRule: "auth.uid != null & owner_id == auth.uid",
                    updateRule: "auth.uid == owner_id & new.owner_id == owner_id",
                    deleteRule: "auth.uid == owner_id",
                },
    ],
        },
    ],

    // Optional: Email support via Mailgun, Resend, or Cloudflare Email Service
    email: {
        from: "My App <noreply@myapp.com>",
        tags: ["backend"],
        variables: {
            company_name: "My App",
            company_copyright: "My App Inc.",
            company_address: "San Francisco, CA",
            support_email: "support@myapp.com",
            company_url: "https://myapp.com",
        },
        resend: {
            RESEND_API_KEY: "$RESEND_API_KEY",
            RESEND_WEBHOOK_SECRET: "$RESEND_WEBHOOK_SECRET",
        },
        // Alternative: cloudflare: {},  // Workers send_email binding; no API keys; domain must be onboarded via `npx wrangler email sending enable <domain>`
    },
} satisfies DatabaseSettings
```

Values prefixed with `$` (e.g., `$JWT_SECRET_MAIN`) are resolved from `.prod.vars` (uploaded to Cloudflare secrets) or `.dev.vars` during local development. To expand this config:

- [Getting Started § Adding a Second Table](getting-started.md#adding-a-second-table) — adding tables with relations and rules
- [Getting Started § Email, OAuth & More](getting-started.md#email-oauth--more) — email verification, password reset, Google login
- [Configuration Reference](config-reference.md) — every option in teenybase.ts

## 5. Add TypeScript Path Alias

Teenybase uses a virtual module (`virtual:teenybase`) to load the config at build time. Add this path mapping to your `tsconfig.json`:

```json
{
    "compilerOptions": {
        "paths": {
            "virtual:teenybase": ["./teenybase"]
        }
    }
}
```

## 6. Update Your Worker Entry Point

Modify your main `src/index.ts` to use `teenyHono()` instead of creating a bare Hono app. This wraps your app with Teenybase middleware that initializes the database on each request.

```ts
import { Hono } from "hono";
import { $Database, $Env, OpenApiExtension, PocketUIExtension, teenyHono } from "teenybase/worker";
import config from "virtual:teenybase";

// Merge Teenybase env types with your existing bindings
export interface Env {
    Bindings: $Env["Bindings"] & CloudflareBindings;
    Variables: $Env["Variables"];
}

// Create the Hono app with Teenybase middleware
const app = teenyHono<Env>(
    async (c) => {
        const db = new $Database(c, config, c.env.PRIMARY_DB /*, c.env.PRIMARY_R2 */);

        // Optional: OpenAPI/Swagger UI at /api/v1/docs
        db.extensions.push(new OpenApiExtension(db, true));

        // Optional: Admin UI at /api/v1/pocket
        db.extensions.push(new PocketUIExtension(db));

        return db;
    },
    undefined,
    {
        cors: {
            origin: [
                "http://localhost:3000",
                "http://localhost:5173",
                "https://myapp.com",
            ],
            allowHeaders: ["*"],
            allowMethods: ["POST", "GET", "OPTIONS", "PUT", "DELETE", "PATCH"],
            exposeHeaders: ["*"],
            maxAge: 600,
            credentials: true,
        },
    }
);

// Your existing routes continue to work below
app.get("/hello", (c) => c.text("Hello!"));

export default app;
```

**Key points:**

- `teenyHono()` creates a Hono app with CORS, logging, and error handling middleware pre-configured.
- The `createDb` callback runs per-request, initializing `$Database` with your config and D1 binding.
- Your existing routes still work — just add them after the `teenyHono()` call.
- Pass an R2 bucket as the fourth argument to `$Database` if you need file storage.

## Using an Existing Hono App

`teenyHono()` accepts an existing Hono app as its second parameter. Instead of creating a new app, you can pass yours in — teenybase adds its middleware (CORS, logging, error handling, `$Database` init) to it:

```typescript
import { Hono } from "hono"
import { $Database, $Env, teenyHono } from "teenybase/worker"
import config from "virtual:teenybase"

const app = new Hono<Env>()

// Your existing routes
app.get("/", (c) => c.text("Home"))
app.get("/health", (c) => c.json({ ok: true }))

// Add teenybase middleware and routes to your app
teenyHono<Env>(async (c) => {
    return new $Database(c, config, c.env.PRIMARY_DB)
}, app)

export default app
```

Your routes and teenybase's `/api/v1/*` routes coexist on the same app.

## Mounting Under a Sub-Path

If you want teenybase at a custom prefix (e.g., `/backend/api/v1/...` instead of `/api/v1/...`), mount the teenybase app using Hono's `app.route()`:

```typescript
import { Hono } from "hono"
import { $Database, $Env, teenyHono } from "teenybase/worker"
import config from "virtual:teenybase"

const teenybaseApp = teenyHono<Env>(async (c) => {
    return new $Database(c, config, c.env.PRIMARY_DB)
})

const app = new Hono<Env>()
app.get("/", (c) => c.text("Home"))
app.route("/backend", teenybaseApp)  // teenybase API at /backend/api/v1/...

export default app
```

Teenybase handles the prefix automatically — all internal routing resolves correctly regardless of the mount path.

## 7. Set Up Secrets

Create a `.dev.vars` file for local development (this file should be in `.gitignore`):

```env
JWT_SECRET_MAIN=your_main_jwt_secret
JWT_SECRET_USERS=your_users_jwt_secret
ADMIN_SERVICE_TOKEN=your_admin_service_token
ADMIN_JWT_SECRET=your_admin_jwt_secret
POCKET_UI_VIEWER_PASSWORD=viewer
POCKET_UI_EDITOR_PASSWORD=editor
```

> **Note:** `apiRoute` is stored in the `infra.jsonc` file (CLI project config, committed to git) rather than in secrets files. It is auto-saved when you deploy.

Add more variables as needed (e.g., `GOOGLE_CLIENT_ID`, `RESEND_API_KEY`) — see [Getting Started § Environment Variables](getting-started.md#environment-variables-secrets).

For production, create a `.prod.vars` file with production values and upload them:

```bash
npm run secrets-upload
```

## 8. Add Package Scripts

Add Teenybase CLI scripts to your `package.json` (see [CLI Reference](cli.md) for all commands and options):

```json
{
    "scripts": {
        "generate": "teeny generate --local",
        "migrate": "teeny deploy --local",
        "backup:local": "teeny backup --local",
        "dev": "teeny dev",
        "build:local": "teeny build --local",
        "exec": "teeny exec --local",

        "deploy": "teeny deploy --remote --log-level debug",
        "secrets-upload": "teeny secrets --remote --upload",
        "build": "teeny build --remote",
        "backup": "teeny backup --remote",
        "generate:remote": "teeny generate --remote",
        "migrate:remote": "teeny deploy --remote",

        "cf-typegen": "wrangler types --env-interface CloudflareBindings"
    }
}
```

## 9. Update .gitignore

Add Teenybase working directories to `.gitignore`:

```gitignore
# Teenybase
.local-persist
.teeny
.tmp.*.json
.prod.vars
.prod.vars*
migrations
```

## 10. Generate Migrations and Run

With everything configured, generate and apply your initial migrations:

```bash
# Generate migration SQL from your config
npm run generate

# Apply migrations and start the dev server
npm run dev
```

For the first remote deployment:

```bash
npx wrangler login   # one-time: authenticate with Cloudflare
npm run deploy       # creates the D1 database, generates + uploads missing secrets from .prod.vars, applies migrations
```

After that, `npm run secrets-upload` is only needed when you change `.prod.vars`.

## API Endpoints

See [API Endpoints](api-endpoints.md) for the full endpoint reference. Key routes once running:

- **Health check:** `GET /api/v1/health`
- **Swagger UI:** `GET /api/v1/doc/ui` (if `OpenApiExtension` enabled)
- **Admin panel:** `GET /api/v1/pocket/` (if `PocketUIExtension` enabled)
- **CRUD:** `GET /api/v1/table/{table}/select`, `/list`, `/view/{id}`, `POST .../insert`, `/update`, `/delete`
- **Auth:** `POST /api/v1/table/{table}/auth/sign-up`, `/login-password`, `/refresh-token`, etc.

## Summary of Changes

| File                        | Change                                                         |
|-----------------------------|----------------------------------------------------------------|
| `package.json`              | Added `teenybase` dependency and CLI scripts                   |
| `wrangler.jsonc`            | Added D1 database binding and `RESPOND_WITH_ERRORS` var        |
| `worker-configuration.d.ts` | Regenerated to include `PRIMARY_DB`                            |
| `tsconfig.json`             | Added `virtual:teenybase` path alias                           |
| `teenybase.ts`              | New — database schema and config                               |
| `src/index.ts`              | Replaced `new Hono()` with `teenyHono()` and `$Database` setup |
| `.dev.vars`                 | New — local secrets                                            |
| `.gitignore`                | Added Teenybase working directories                            |
