/**
 * CLI integration test for the managed deployment workflow.
 *
 * Starts the teenybase proxy backend on port 8686 via `teeny dev` which acts as:
 * 1. A CF API mock — handles wrangler's CF API calls (deploy, d1 query, etc.)
 *    with local D1/R2 bindings and fake deploy responses
 * 2. Platform user management — teenybase at root (/api/v1/*) with sign-up, login, JWT auth
 * 3. Mock worker — teenybase at /mock-worker for testing user worker setup-db/migrations
 *
 * Creates a temp project, runs CLI commands with CLOUDFLARE_API_BASE_URL
 * and apiRoute both pointing at the backend. Full end-to-end test.
 *
 * Run: npx vitest run test/cli-managed.test.ts
 */

import {describe, it, expect, beforeAll, afterAll} from 'vitest'
import {execSync, spawn, type ChildProcess} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const BACKEND_PORT = 8686
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`

// Paths
const repoRoot = path.resolve(import.meta.dirname, '..')
const backendDir = path.join(repoRoot, 'backend')
// The platform backend (backend/) is a separate, non-public package. Without it these suites
// can't run, so they are skipped with the reason in the suite name instead of failing.
const backendMissing = !fs.existsSync(path.join(backendDir, 'package.json'))
const teenyBin = path.join(repoRoot, 'bin', 'teeny.js')

// Temp project directory — created fresh per test suite
let tmpDir: string

// Backend dev server process
let backendProcess: ChildProcess

// Backend .dev.vars backup/restore for mock mode
const devVarsPath = path.join(backendDir, '.dev.vars')
let originalDevVars: string | null = null

/** Kill backend process tree and restore .dev.vars. */
function cleanup() {
    if (backendProcess?.pid) {
        try { process.kill(-backendProcess.pid, 'SIGTERM') } catch {}
        try {
            const start = Date.now()
            while (Date.now() - start < 500) { /* spin wait for cleanup */ }
            process.kill(-backendProcess.pid, 'SIGKILL')
        } catch { /* already dead — good */ }
    }
    if (originalDevVars !== null) {
        fs.writeFileSync(devVarsPath, originalDevVars)
        originalDevVars = null
    }
}

// Ensure cleanup runs even if vitest crashes or the process is interrupted
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

/** Run a teeny CLI command in the temp project directory with managed env */
function teeny(args: string, options?: { env?: Record<string, string>, timeout?: number }) {
    const env = {
        ...process.env,
        // Route wrangler CF API calls to our proxy backend
        CLOUDFLARE_API_BASE_URL: `${BACKEND_URL}/client/v4`,
        WRANGLER_SEND_METRICS: 'false',
        // Fake CF credentials so wrangler doesn't prompt for login
        CLOUDFLARE_API_TOKEN: 'test-managed-token',
        CLOUDFLARE_ACCOUNT_ID: 'tb-test-account-id',
        ...options?.env,
    }
    const cmd = `node ${JSON.stringify(teenyBin)} ${args}`
    console.log('Executing command', cmd, tmpDir)
    return execSync(cmd, {
        cwd: tmpDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: options?.timeout ?? 60_000,
    })
}

/** Run teeny and capture both stdout+stderr, never throws */
function teenySafe(args: string, options?: { env?: Record<string, string>, timeout?: number }): { stdout: string, stderr: string, ok: boolean } {
    try {
        const stdout = teeny(args, options).toString()
        return {stdout, stderr: '', ok: true}
    } catch (e: any) {
        return {
            stdout: e.stdout?.toString() || '',
            stderr: e.stderr?.toString() || '',
            ok: false,
        }
    }
}

/** Create a minimal teenybase project in a temp directory */
function createTempProject() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teeny-cli-test-'))

    // teeny.config.ts — simple config with one table
    fs.writeFileSync(path.join(dir, 'teeny.config.ts'), `
import type {DatabaseSettings, TableRulesExtensionData} from '${repoRoot}/src'

export default {
    appUrl: "${BACKEND_URL}",
    jwtSecret: 'test-jwt-secret-managed',
    tables: [
        {
            name: 'notes',
            fields: [
                {
                    name: 'id', sqlType: 'text', type: 'text', usage: 'record_uid',
                    primary: true, noUpdate: true, noInsert: true,
                },
                {name: 'title', sqlType: 'text', type: 'text', notNull: true},
                {name: 'body', sqlType: 'text', type: 'text'},
            ],
            extensions: [{
                name: "rules",
                listRule: 'true',
                viewRule: 'true',
                createRule: 'true',
                updateRule: 'true',
                deleteRule: 'true',
            } as TableRulesExtensionData]
        }
    ],
} satisfies DatabaseSettings
`)

    // Worker entry point — standalone (no cloudflare:test imports)
    fs.writeFileSync(path.join(dir, 'worker.ts'), `
import {$Database, $Env, teenyHono} from '${repoRoot}/src/worker'
import settings from 'virtual:teenybase'
type Env = $Env
const app = teenyHono<Env>(async (c) => {
    return new $Database(c, settings, c.env.PRIMARY_DB)
})
export default app
`)

    // wrangler.jsonc — minimal config with D1 binding
    fs.writeFileSync(path.join(dir, 'wrangler.jsonc'), JSON.stringify({
        name: 'test-managed-worker',
        main: 'worker.ts',
        compatibility_date: '2025-01-01',
        compatibility_flags: ['nodejs_compat'],
        account_id: 'tb-test-account-id',
        d1_databases: [{
            binding: 'PRIMARY_DB',
            database_name: 'test-managed-db',
            database_id: 'test-db-id-00000000',
            migrations_dir: 'migrations',
        }],
        vars: {
            ADMIN_SERVICE_TOKEN: 'test-admin-token',
            ADMIN_JWT_SECRET: 'test-jwt-secret',
            RESPOND_WITH_ERRORS: true,
        },
    }, null, 2))

    // tsconfig.json
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
            target: 'ESNext',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            skipLibCheck: true,
            esModuleInterop: true,
            lib: ['ESNext'],
            types: ['@cloudflare/workers-types'],
        },
    }, null, 2))

    // .dev.vars — secrets for local mode
    fs.writeFileSync(path.join(dir, '.dev.vars'), [
        `ADMIN_SERVICE_TOKEN=test-admin-token`,
    ].join('\n'))

    // .prod.vars — secrets only
    fs.writeFileSync(path.join(dir, '.prod.vars'), [
        `ADMIN_SERVICE_TOKEN=test-admin-token`,
    ].join('\n'))

    // infra.jsonc — project config with apiRoute pointing to /mock-worker for setup-db/migrations
    // Use 127.0.0.1 instead of localhost — the CLI rejects localhost apiRoute for --remote
    fs.writeFileSync(path.join(dir, 'infra.jsonc'), JSON.stringify({apiRoute: `http://127.0.0.1:${BACKEND_PORT}/mock-worker`}, null, 2))

    // migrations/ directory
    fs.mkdirSync(path.join(dir, 'migrations'), {recursive: true})

    return dir
}

/** Wait for the backend to be ready by polling /health */
async function waitForBackend(timeoutMs = 30_000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        try {
            const resp = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(1000) })
            if (resp.ok) return
        } catch {}
        await new Promise(r => setTimeout(r, 500))
    }
    throw new Error(`Backend did not become ready within ${timeoutMs}ms`)
}

describe.skipIf(backendMissing)('CLI managed deployment workflow' + (backendMissing ? ' [skipped: needs backend/, not in this checkout]' : ''), () => {

    beforeAll(async () => {
        // 1. Clear backend local state from previous runs to ensure fresh database
        const localPersist = path.join(backendDir, '.local-persist')
        if (fs.existsSync(localPersist)) {
            fs.rmSync(localPersist, {recursive: true, force: true})
        }
        const wranglerState = path.join(backendDir, '.wrangler', 'state')
        if (fs.existsSync(wranglerState)) {
            fs.rmSync(wranglerState, {recursive: true, force: true})
        }

        // 2. Replace .dev.vars with mock-mode version (no CF credentials)
        //    so wrangler doesn't activate proxy mode inside the worker
        if (fs.existsSync(devVarsPath)) {
            originalDevVars = fs.readFileSync(devVarsPath, 'utf8')
        }
        fs.writeFileSync(devVarsPath, [
            'CF_API_TOKEN=',
            'CF_ACCOUNT_ID=',
            'PLATFORM_JWT_SECRET=test-platform-jwt-secret',
            'PLATFORM_AUTH_JWT_SECRET=test-platform-auth-jwt-secret',
            'ADMIN_SERVICE_TOKEN=test-admin-token',
            'ADMIN_JWT_SECRET=test-jwt-secret-backend',
        ].join('\n'))

        // 3. Run deploy --local to create platform_users table
        execSync(`node ${JSON.stringify(teenyBin)} deploy --local --root ${JSON.stringify(backendDir)} --yes`, {
            cwd: repoRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 60_000,
        })

        // 4. Create temp project
        tmpDir = createTempProject()
        console.log(`Temp project: ${tmpDir}`)

        // 5. Start the backend via teeny dev (spawned in new process group)
        //    detached + process.kill(-pid) ensures the whole tree gets killed on cleanup
        backendProcess = spawn('node', [teenyBin, 'dev', '--local', '--root', backendDir], {
            cwd: repoRoot,
            detached: true,
            env: {
                ...process.env,
                WRANGLER_SEND_METRICS: 'false',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        })

        // Drain stdout/stderr to prevent OS pipe buffer (64KB) from filling up.
        // If the buffer fills, wrangler's writes block, its event loop stalls, and it exits.
        backendProcess.stdout?.resume()
        backendProcess.stderr?.resume()

        // 6. Wait for backend to be ready
        await waitForBackend()

        // Verify health — proxyMode should be false (mock mode)
        const health = await fetch(`${BACKEND_URL}/health`)
        expect(health.status).toBe(200)
        const body = await health.json() as any
        expect(body.status).toBe('ok')
        expect(body.proxyMode).toBe(false)
    }, 60_000)

    afterAll(async () => {
        cleanup()
        // Wait for process to actually exit
        if (backendProcess) {
            await new Promise<void>(resolve => {
                backendProcess.on('exit', () => resolve())
                setTimeout(resolve, 5000)
            })
        }
        if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, {recursive: true, force: true})
        }
    })

    // --- Local workflow test (validates CLI + config pipeline) ---

    it('should generate and deploy --local successfully', { timeout: 30_000 }, () => {
        // Generate migrations
        teeny('generate --local --clean')

        const migrationsDir = path.join(tmpDir, 'migrations')
        const sqlFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'))
        expect(sqlFiles.length).toBeGreaterThan(0)
        expect(fs.existsSync(path.join(migrationsDir, 'next-config.json'))).toBe(true)

        // Apply migrations
        teeny('deploy --local --yes', {timeout: 30_000})

        expect(fs.existsSync(path.join(tmpDir, '.local-persist', 'config.json'))).toBe(true)
        expect(fs.existsSync(path.join(migrationsDir, 'next-config.json'))).toBe(false)
    })

    // --- Backend unit tests (direct fetch to proxy worker) ---

    it('should reject CF API requests without auth', async () => {
        const resp = await fetch(`${BACKEND_URL}/client/v4/accounts/abc/d1/database/db1/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({sql: 'SELECT 1'}),
        })
        expect(resp.status).toBe(401)
        const body = await resp.json() as any
        expect(body.success).toBe(false)
        expect(body.errors[0].message).toContain('Authentication required')
    })

    it('health endpoint should not require auth', async () => {
        const resp = await fetch(`${BACKEND_URL}/health`)
        expect(resp.status).toBe(200)
    })

    it('should return 404 for unmatched CF API routes', async () => {
        const resp = await fetch(`${BACKEND_URL}/client/v4/accounts/abc/some/unknown/path`, {
            headers: {'Authorization': 'Bearer test-token'},
        })
        expect(resp.status).toBe(404)
        const body = await resp.json() as any
        expect(body.success).toBe(false)
        expect(body.errors[0].message).toContain('Not found')
    })

    it('should execute D1 query via mock handler', async () => {
        const resp = await fetch(`${BACKEND_URL}/client/v4/accounts/test/d1/database/db1/query`, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer test-token',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({sql: 'SELECT 1 as val'}),
        })
        expect(resp.status).toBe(200)
        const body = await resp.json() as any
        expect(body.success).toBe(true)
        expect(body.result).toBeInstanceOf(Array)
        expect(body.result[0].results[0].val).toBe(1)
    })

    it('should return empty deployments for unknown workers', async () => {
        const resp = await fetch(
            `${BACKEND_URL}/client/v4/accounts/test/workers/scripts/some-worker/deployments`,
            { headers: {'Authorization': 'Bearer test-token'} },
        )
        expect(resp.status).toBe(200)
        const body = await resp.json() as any
        expect(body.success).toBe(true)
        // Unknown workers start with zero deployments (first-time deploy scenario)
        expect(body.result.deployments.length).toBe(0)
    })

    // --- First-time deploy (no prior deployments) ---

    it('should enter first-time deploy path when no deployments exist', { timeout: 60_000 }, () => {
        // Remove apiRoute to simulate a brand new project
        fs.writeFileSync(path.join(tmpDir, '.prod.vars'), [
            `ADMIN_SERVICE_TOKEN=test-admin-token`,
        ].join('\n'))

        // Generate migrations from scratch (no apiRoute = "not deployed")
        teeny('generate --remote --clean', {timeout: 30_000})

        // Deploy — no prior deployments → enters first-time deploy path.
        // The CLI deploys the worker and secrets successfully, but then
        // fetchWorker(setup-db) fails because it uses the workers.dev URL
        // extracted from wrangler output (not reachable in test environment).
        // We verify the first-time deploy steps happened correctly.
        const result = teenySafe('deploy --remote --yes --migrate --deploy', {timeout: 60_000})
        const combined = result.stdout + result.stderr
        console.log('first-time deploy stdout:', result.stdout)
        if (result.stderr) console.log('first-time deploy stderr:', result.stderr)

        expect(combined).toContain('Continuing with first time deployment')
        expect(combined).toContain('Deploying worker for the first time')
        expect(combined).toContain('Deployed test-managed-worker')

        // Restore apiRoute for other tests (pointing to /mock-worker)
        fs.writeFileSync(path.join(tmpDir, '.prod.vars'), `ADMIN_SERVICE_TOKEN=test-admin-token\n`)
        fs.writeFileSync(path.join(tmpDir, 'infra.jsonc'), JSON.stringify({apiRoute: `http://127.0.0.1:${BACKEND_PORT}/mock-worker`}, null, 2))
    })

    // --- Platform auth (Phase 7) ---
    // These tests depend on the backend being responsive after the heavy deploy tests above.
    // waitForBackend() ensures workerd has recovered from processing multipart uploads.

    describe('platform auth', () => {
    beforeAll(async () => { await waitForBackend() })

    it('should sign up a new platform user', async () => {
        const resp = await fetch(`${BACKEND_URL}/api/v1/table/platform_users/auth/sign-up`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'testuser',
                email: 'test@example.com',
                password: 'testpassword123',
                passwordConfirm: 'testpassword123',
                name: 'Test User',
            }),
        })
        expect(resp.status).toBe(200)
        const body = await resp.json() as any
        expect(body.token).toBeTruthy()
        expect(body.record).toBeTruthy()
        expect(body.record.email).toBe('test@example.com')
        expect(body.record.username).toBe('testuser')
    })

    it('should login with password and get JWT', async () => {
        const resp = await fetch(`${BACKEND_URL}/api/v1/table/platform_users/auth/login-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                identity: 'test@example.com',
                password: 'testpassword123',
            }),
        })
        expect(resp.status).toBe(200)
        const body = await resp.json() as any
        expect(body.token).toBeTruthy()
        expect(body.record).toBeTruthy()
        expect(body.record.email).toBe('test@example.com')
    })

    it('should use platform JWT directly for proxy auth', async () => {
        // First login to get a JWT
        const loginResp = await fetch(`${BACKEND_URL}/api/v1/table/platform_users/auth/login-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                identity: 'test@example.com',
                password: 'testpassword123',
            }),
        })
        const loginBody = await loginResp.json() as any
        const jwt = loginBody.token

        // Platform JWT should work directly for proxy auth (no bridge needed)
        const verifyResp = await fetch(`${BACKEND_URL}/client/v4/user/tokens/verify`, {
            headers: { 'Authorization': `Bearer ${jwt}` },
        })
        // Note: may be 403 EMAIL_NOT_VERIFIED if verification is enforced
        expect([200, 403]).toContain(verifyResp.status)
    })

    it('should reject proxy request with invalid JWT', async () => {
        const resp = await fetch(`${BACKEND_URL}/client/v4/user/tokens/verify`, {
            headers: { 'Authorization': 'Bearer invalid-jwt-token' },
        })
        expect(resp.status).toBe(401)
    })

    }) // end platform auth

    // --- Auth edge cases (Phase 12) ---

    it('should reject duplicate email registration', async () => {
        // test@example.com was already registered in the platform auth tests above
        const resp = await fetch(`${BACKEND_URL}/api/v1/table/platform_users/auth/sign-up`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'testuser2',
                email: 'test@example.com',
                password: 'differentpassword123',
                passwordConfirm: 'differentpassword123',
                name: 'Duplicate User',
            }),
        })
        // Should fail — not a 500 (server error), but a client error
        expect(resp.status).toBeGreaterThanOrEqual(400)
        expect(resp.status).toBeLessThan(500)
    })

    it('should reject login with wrong password', async () => {
        const resp = await fetch(`${BACKEND_URL}/api/v1/table/platform_users/auth/login-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                identity: 'test@example.com',
                password: 'wrong-password-123',
            }),
        })
        expect(resp.status).toBe(400)
    })

    // --- CLI auth commands (Phase 8) ---

    it('should show "not logged in" when no credentials exist', () => {
        // Ensure no credentials file exists
        const credPath = path.join(os.homedir(), '.teenybase', 'credentials.json')
        const hadCreds = fs.existsSync(credPath)
        let originalCreds: string | null = null
        if (hadCreds) {
            originalCreds = fs.readFileSync(credPath, 'utf8')
            fs.unlinkSync(credPath)
        }
        try {
            const result = teenySafe('whoami', {env: {CLOUDFLARE_API_BASE_URL: '', CLOUDFLARE_API_TOKEN: ''}})
            expect(result.ok).toBe(true)
            expect(result.stdout).toContain('Not logged in')
        } finally {
            if (originalCreds !== null) {
                fs.mkdirSync(path.dirname(credPath), {recursive: true})
                fs.writeFileSync(credPath, originalCreds)
            }
        }
    })

    it('should save credentials and whoami should show email', async () => {
        // Ensure backend is alive (may have been stressed by prior tests)
        await waitForBackend()

        // Simulate login by calling the auth API directly and saving credentials
        const loginResp = await fetch(`${BACKEND_URL}/api/v1/table/platform_users/auth/login-password`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({identity: 'test@example.com', password: 'testpassword123'}),
        })
        expect(loginResp.status).toBe(200)
        const loginBody = await loginResp.json() as any
        const jwt = loginBody.token
        expect(jwt).toBeTruthy()

        // Save credentials (what register/login CLI commands do — platform JWT directly)
        const credPath = path.join(os.homedir(), '.teenybase', 'credentials.json')
        const hadCreds = fs.existsSync(credPath)
        let originalCreds: string | null = null
        if (hadCreds) {
            originalCreds = fs.readFileSync(credPath, 'utf8')
        }
        try {
            fs.mkdirSync(path.dirname(credPath), {recursive: true})
            fs.writeFileSync(credPath, JSON.stringify({
                serverUrl: BACKEND_URL,
                email: 'test@example.com',
                apiToken: jwt,
                refreshToken: loginBody.refresh_token,
            }, null, 2))

            // whoami should show the email
            const result = teenySafe('whoami', {env: {CLOUDFLARE_API_BASE_URL: '', CLOUDFLARE_API_TOKEN: ''}})
            expect(result.ok).toBe(true)
            expect(result.stdout).toContain('test@example.com')
            expect(result.stdout).toContain(BACKEND_URL)
        } finally {
            if (originalCreds !== null) {
                fs.writeFileSync(credPath, originalCreds)
            } else if (fs.existsSync(credPath)) {
                fs.unlinkSync(credPath)
            }
        }
    })

    it('should logout and remove credentials', () => {
        const credPath = path.join(os.homedir(), '.teenybase', 'credentials.json')
        const hadCreds = fs.existsSync(credPath)
        let originalCreds: string | null = null
        if (hadCreds) {
            originalCreds = fs.readFileSync(credPath, 'utf8')
        }
        try {
            // Write fake credentials
            fs.mkdirSync(path.dirname(credPath), {recursive: true})
            fs.writeFileSync(credPath, JSON.stringify({
                serverUrl: BACKEND_URL,
                email: 'test@example.com',
                apiToken: 'fake-token',
            }))

            // Logout should remove them
            const result = teenySafe('logout', {env: {CLOUDFLARE_API_BASE_URL: '', CLOUDFLARE_API_TOKEN: ''}})
            expect(result.ok).toBe(true)
            expect(result.stdout).toContain('Logged out')
            expect(fs.existsSync(credPath)).toBe(false)
        } finally {
            if (originalCreds !== null) {
                fs.mkdirSync(path.dirname(credPath), {recursive: true})
                fs.writeFileSync(credPath, originalCreds)
            }
        }
    })

    // --- Worker management (Phase 10) ---

    describe('worker management API', () => {
        // In mock mode, authMiddleware maps any bearer token to userId='mock-user'.
        // Resources must be seeded with this user_id to be visible.
        // D1 enforces foreign keys, so we must create a user record first.
        const mockUserId = 'mock-user'

        beforeAll(async () => {
            await waitForBackend()

            // Create a user record with id='mock-user' to satisfy foreign key constraint
            const seedUser = await fetch(`${BACKEND_URL}/admin/seed-user`, {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer test-admin-token',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email: 'mock@test.com', id: mockUserId }),
            })
            expect(seedUser.status).toBe(200)

            // Seed a worker resource for mock-user
            const seedWorker = await fetch(`${BACKEND_URL}/admin/seed-resource`, {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer test-admin-token',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    user_id: mockUserId,
                    type: 'worker',
                    logical_name: 'my-app',
                }),
            })
            expect(seedWorker.status).toBe(200)

            // Seed a D1 database resource
            const seedDb = await fetch(`${BACKEND_URL}/admin/seed-resource`, {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer test-admin-token',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    user_id: mockUserId,
                    type: 'd1',
                    logical_name: 'primary-db',
                    cf_id: 'test-cf-db-id-123',
                    metadata: { worker: 'my-app' },
                }),
            })
            expect(seedDb.status).toBe(200)
        })

        it('should list workers for authenticated user', async () => {
            const resp = await fetch(`${BACKEND_URL}/client/v4/managed/workers`, {
                headers: { 'Authorization': 'Bearer test-token' },
            })
            expect(resp.status).toBe(200)
            const body = await resp.json() as any
            expect(body.success).toBe(true)
            expect(body.result).toBeInstanceOf(Array)
            expect(body.result.length).toBe(1)
            expect(body.result[0].name).toBe('my-app')
            expect(body.result[0].databases.length).toBe(1)
            expect(body.result[0].databases[0].name).toBe('primary-db')
        })

        it('should get status for a specific worker', async () => {
            const resp = await fetch(`${BACKEND_URL}/client/v4/managed/workers/my-app`, {
                headers: { 'Authorization': 'Bearer test-token' },
            })
            expect(resp.status).toBe(200)
            const body = await resp.json() as any
            expect(body.success).toBe(true)
            expect(body.result.name).toBe('my-app')
            expect(body.result.cf_name).toMatch(/^tb-[a-f0-9]{32}$/)
            expect(body.result.databases.length).toBe(1)
        })

        it('should return 404 for non-existent worker status', async () => {
            const resp = await fetch(`${BACKEND_URL}/client/v4/managed/workers/no-such-worker`, {
                headers: { 'Authorization': 'Bearer test-token' },
            })
            expect(resp.status).toBe(404)
            const body = await resp.json() as any
            expect(body.success).toBe(false)
        })

        it('should return 404 when deleting non-existent worker', async () => {
            const resp = await fetch(`${BACKEND_URL}/client/v4/managed/workers/no-such-worker`, {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer test-token' },
            })
            expect(resp.status).toBe(404)
        })

        it('should delete worker and associated databases', async () => {
            const resp = await fetch(`${BACKEND_URL}/client/v4/managed/workers/my-app`, {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer test-token' },
            })
            expect(resp.status).toBe(200)
            const body = await resp.json() as any
            expect(body.success).toBe(true)
            expect(body.result.deleted.workers).toContain('my-app')
            expect(body.result.deleted.databases).toContain('primary-db')

            // Verify the worker is gone
            const listResp = await fetch(`${BACKEND_URL}/client/v4/managed/workers`, {
                headers: { 'Authorization': 'Bearer test-token' },
            })
            const listBody = await listResp.json() as any
            expect(listBody.result.length).toBe(0)
        })

        it('should require auth for management endpoints', async () => {
            const resp = await fetch(`${BACKEND_URL}/client/v4/managed/workers`)
            expect(resp.status).toBe(401)
        })
    })

    // --- Worker proxy (mock mode) ---

    it('should return 501 for worker-proxy in mock mode', async () => {
        const resp = await fetch(`${BACKEND_URL}/worker-proxy/some-worker/api/v1/setup-db`, {
            method: 'POST',
            headers: { 'X-Platform-Token': 'any-token' },
        })
        expect(resp.status).toBe(501)
        const body = await resp.json() as any
        expect(body.error).toContain('mock mode')
    })

    // --- CLI management commands (Phase 10) ---

    describe('CLI management commands', () => {
        // In mock mode, authMiddleware maps any bearer token to userId='mock-user'.
        // We need to:
        // 1. Write credentials with any token (mock mode accepts anything)
        // 2. Seed resources with user_id='mock-user'
        // But first we must re-seed since the API tests above may have deleted resources.
        const mockUserId = 'mock-user'
        const credPath = path.join(os.homedir(), '.teenybase', 'credentials.json')
        let originalCreds: string | null = null

        beforeAll(async () => {
            await waitForBackend()

            // Save existing credentials
            if (fs.existsSync(credPath)) {
                originalCreds = fs.readFileSync(credPath, 'utf8')
            }

            // Write credentials file — any token works in mock mode
            fs.mkdirSync(path.dirname(credPath), { recursive: true })
            fs.writeFileSync(credPath, JSON.stringify({
                serverUrl: BACKEND_URL,
                email: 'cli-mgmt@example.com',
                apiToken: 'any-token-works-in-mock-mode',
            }, null, 2))

            // Seed resources for CLI tests (with mock-user since that's what auth middleware returns)
            await fetch(`${BACKEND_URL}/admin/seed-resource`, {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer test-admin-token',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    user_id: mockUserId,
                    type: 'worker',
                    logical_name: 'cli-test-app',
                }),
            })
            await fetch(`${BACKEND_URL}/admin/seed-resource`, {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer test-admin-token',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    user_id: mockUserId,
                    type: 'd1',
                    logical_name: 'cli-test-db',
                    cf_id: 'cli-test-cf-db-id',
                    metadata: { worker: 'cli-test-app' },
                }),
            })
        })

        afterAll(() => {
            // Restore original credentials
            if (originalCreds !== null) {
                fs.writeFileSync(credPath, originalCreds)
            } else if (fs.existsSync(credPath)) {
                fs.unlinkSync(credPath)
            }
        })

        it('should list workers via CLI', () => {
            const result = teenySafe('list', { env: { CLOUDFLARE_API_BASE_URL: '', CLOUDFLARE_API_TOKEN: '' } })
            expect(result.ok).toBe(true)
            expect(result.stdout).toContain('cli-test-app')
        })

        it('should show worker status via CLI', () => {
            const result = teenySafe('status cli-test-app', { env: { CLOUDFLARE_API_BASE_URL: '', CLOUDFLARE_API_TOKEN: '' } })
            expect(result.ok).toBe(true)
            expect(result.stdout).toContain('cli-test-app')
            expect(result.stdout).toContain('Created:')
        })

        it('should show error for non-existent worker status', () => {
            const result = teenySafe('status no-such-worker', { env: { CLOUDFLARE_API_BASE_URL: '', CLOUDFLARE_API_TOKEN: '' } })
            expect(result.ok).toBe(false)
            expect(result.stderr).toContain('not found')
        })

        it('should delete worker via CLI with --yes', () => {
            const result = teenySafe('delete cli-test-app --yes', { env: { CLOUDFLARE_API_BASE_URL: '', CLOUDFLARE_API_TOKEN: '' } })
            expect(result.ok).toBe(true)
            expect(result.stdout).toContain('Deleted worker')
            expect(result.stdout).toContain('cli-test-app')

            // Verify it's gone
            const listResult = teenySafe('list', { env: { CLOUDFLARE_API_BASE_URL: '', CLOUDFLARE_API_TOKEN: '' } })
            expect(listResult.ok).toBe(true)
            expect(listResult.stdout).toContain('No workers deployed')
        })
    })

    // --- Full end-to-end remote workflow (re-deploy → migrate → no-op) ---

    it('should generate, deploy+migrate, and detect no changes on re-run --remote', { timeout: 120_000 }, async () => {
        // Seed a deployment via the mock API so `wrangler deployments list` returns non-empty.
        // This makes the test self-contained — it doesn't depend on any prior test.
        const seedResp = await fetch(
            `${BACKEND_URL}/client/v4/accounts/test-account-id/workers/scripts/test-managed-worker/deployments`,
            {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer test-token',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    strategy: 'percentage',
                    versions: [{version_id: '00000000-seed-0000-0000-000000000000', percentage: 100}],
                }),
            },
        )
        expect(seedResp.ok).toBe(true)

        // 1. Generate migrations against remote D1
        const genResult = teenySafe('generate --remote --clean', {timeout: 30_000})
        console.log('generate --remote stdout:', genResult.stdout)
        if (genResult.stderr) console.log('generate --remote stderr:', genResult.stderr)
        expect(genResult.ok).toBe(true)

        const migrationsDir = path.join(tmpDir, 'migrations')
        const sqlFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'))
        expect(sqlFiles.length).toBeGreaterThan(0)
        expect(fs.existsSync(path.join(migrationsDir, 'next-config.json'))).toBe(true)

        // 2. Deploy + migrate: re-deploy → apply migrations → final deploy
        const deployResult = teenySafe('deploy --remote --yes --migrate --deploy', {timeout: 60_000})
        console.log('deploy --remote stdout:', deployResult.stdout)
        if (deployResult.stderr) console.log('deploy --remote stderr:', deployResult.stderr)

        const deployOut = deployResult.stdout + deployResult.stderr
        expect(deployOut).toContain('Deployed test-managed-worker')
        expect(deployOut).toContain('Applied 1 migration')
        expect(deployResult.ok).toBe(true)
        expect(fs.existsSync(path.join(migrationsDir, 'next-config.json'))).toBe(false)

        // 3. Re-run deploy — should detect no changes and skip deployment
        // (migrate defaults to --deploy=false, so it skips if no config/migration changes)
        const rerunResult = teenySafe('deploy --remote --yes', {timeout: 60_000})
        console.log('migrate --remote (subsequent) stdout:', rerunResult.stdout)
        if (rerunResult.stderr) console.log('migrate --remote (subsequent) stderr:', rerunResult.stderr)

        const rerunOut = rerunResult.stdout + rerunResult.stderr
        expect(rerunOut).toContain('Skipping worker deployment')
        expect(rerunResult.ok).toBe(true)
    })
})
