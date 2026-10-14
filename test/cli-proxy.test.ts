/**
 * CLI proxy integration test for the managed deployment service.
 *
 * This test runs the REAL proxy flow: wrangler → our backend → Cloudflare API.
 * CF credentials are read by the backend from backend/.dev.vars:
 *   CF_API_TOKEN   — Cloudflare API token with Workers + D1 scopes
 *   CF_ACCOUNT_ID  — Platform Cloudflare account ID
 *
 * If those are empty, tests auto-skip (backend runs in mock mode).
 *
 * Run: npx vitest run test/cli-proxy.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync, exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'

const execAsync = promisify(execCb)

// Detected at runtime by probing the backend
let proxyMode = false

const BACKEND_PORT = 8687
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`

const repoRoot = path.resolve(import.meta.dirname, '..')
const backendDir = path.join(repoRoot, 'backend')
// The platform backend (backend/) is a separate, non-public package. Without it these suites
// can't run, so they are skipped with the reason in the suite name instead of failing.
const backendMissing = !fs.existsSync(path.join(backendDir, 'package.json'))
const teenyBin = path.join(repoRoot, 'bin', 'teeny.js')

let tmpDir: string
let backend: Unstable_DevWorker

// The actual JWT token is set by seed-user in beforeAll
let TEST_USER_TOKEN = ''
const TEST_USER_EMAIL = `proxy-test-${Date.now()}@teenybase.test`
const ADMIN_TOKEN = 'test-admin-token'

/** Read CF credentials from backend/.dev.vars */
function readCfCredentials(): { accountId: string, apiToken: string } | null {
    const devVarsPath = path.join(backendDir, '.dev.vars')
    if (!fs.existsSync(devVarsPath)) return null
    const vars: Record<string, string> = {}
    for (const line of fs.readFileSync(devVarsPath, 'utf-8').split('\n')) {
        const eq = line.indexOf('=')
        if (eq > 0) vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    if (!vars.CF_ACCOUNT_ID || !vars.CF_API_TOKEN) return null
    return { accountId: vars.CF_ACCOUNT_ID, apiToken: vars.CF_API_TOKEN }
}

/**
 * Clean up CF resources (workers + D1 databases) left over from previous test runs.
 * Uses DELETE /workers/services/:name (not /scripts/:name) to fully remove the
 * service, including all deployments and versions. Using /scripts/:name leaves
 * the service container, causing wrangler to show ERRORs on next deploy.
 */
async function cleanupCfResources() {
    const creds = readCfCredentials()
    if (!creds) return

    const headers = { 'Authorization': `Bearer ${creds.apiToken}` }
    const cfBase = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}`

    try {
        // Delete test worker SERVICES (not scripts — services removes everything)
        const workersResp = await fetch(`${cfBase}/workers/scripts`, { headers })
        const workersBody = await workersResp.json() as any
        for (const w of workersBody.result || []) {
            if (w.id.includes('proxy-test-worker')) {
                const delResp = await fetch(`${cfBase}/workers/services/${w.id}?force=true`, { method: 'DELETE', headers })
                console.log(`Cleaned up worker service: ${w.id} (${delResp.status})`)
            }
        }
        // Delete test D1 databases — matches both original and normalized binding names
        const d1Resp = await fetch(`${cfBase}/d1/database`, { headers })
        const d1Body = await d1Resp.json() as any
        for (const db of d1Body.result || []) {
            if (db.name.includes('proxy-test') || db.name.includes('primary-db')) {
                const delResp = await fetch(`${cfBase}/d1/database/${db.uuid}`, { method: 'DELETE', headers })
                console.log(`Cleaned up D1: ${db.name} (${delResp.status})`)
            }
        }
    } catch (e) {
        console.error('Cleanup failed:', e)
    }
}

/** Common env vars for teeny CLI commands routed through the proxy */
function teenyEnv(overrides?: Record<string, string>): Record<string, string> {
    return {
        ...process.env as Record<string, string>,
        CLOUDFLARE_API_BASE_URL: `${BACKEND_URL}/client/v4`,
        WRANGLER_SEND_METRICS: 'false',
        CLOUDFLARE_API_TOKEN: TEST_USER_TOKEN,
        CLOUDFLARE_ACCOUNT_ID: 'tb-proxy-test-account',
        ...overrides,
    }
}

/**
 * Run a teeny CLI command asynchronously.
 * Uses exec (non-blocking) so the Node.js event loop stays responsive
 * and vitest's internal RPC doesn't time out during long CF API calls.
 */
async function teeny(args: string, options?: { env?: Record<string, string>, timeout?: number }): Promise<{ stdout: string, stderr: string }> {
    const cmd = `node ${JSON.stringify(teenyBin)} ${args}`
    console.log('Executing:', cmd)
    return execAsync(cmd, {
        cwd: tmpDir,
        env: teenyEnv(options?.env),
        timeout: options?.timeout ?? 60_000,
        maxBuffer: 10 * 1024 * 1024,
    })
}

function createTempProject() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teeny-proxy-test-'))

    fs.writeFileSync(path.join(dir, 'teeny.config.ts'), `
import type {DatabaseSettings, TableRulesExtensionData} from '${repoRoot}/src'

export default {
    appUrl: "${BACKEND_URL}",
    jwtSecret: 'test-jwt-secret-proxy',
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

    fs.writeFileSync(path.join(dir, 'worker.ts'), `
import {$Database, $Env, teenyHono} from '${repoRoot}/src/worker'
import settings from 'virtual:teenybase'
type Env = $Env
const app = teenyHono<Env>(async (c) => {
    return new $Database(c, settings, c.env.PRIMARY_DB)
})
export default app
`)

    fs.writeFileSync(path.join(dir, 'wrangler.jsonc'), JSON.stringify({
        name: 'proxy-test-worker',
        main: 'worker.ts',
        compatibility_date: '2025-01-01',
        compatibility_flags: ['nodejs_compat'],
        account_id: 'tb-proxy-test-account',
        workers_dev: true,
        d1_databases: [{
            binding: 'PRIMARY_DB',
            database_name: 'proxy-test-db',
            database_id: 'proxy-test-db-id',
            migrations_dir: 'migrations',
        }],
        vars: {
            ADMIN_SERVICE_TOKEN: 'test-admin-token',
            ADMIN_JWT_SECRET: 'test-jwt-secret',
            RESPOND_WITH_ERRORS: true,
        },
    }, null, 2))

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

    fs.writeFileSync(path.join(dir, '.dev.vars'), `ADMIN_SERVICE_TOKEN=test-admin-token`)

    // .prod.vars — secrets only (no apiRoute)
    fs.writeFileSync(path.join(dir, '.prod.vars'), '')

    // infra.jsonc — project config with apiRoute
    fs.writeFileSync(path.join(dir, 'infra.jsonc'), JSON.stringify({apiRoute: `http://127.0.0.1:${BACKEND_PORT}`}, null, 2))

    fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true })

    return dir
}

describe.skipIf(backendMissing)('CLI proxy deployment (real CF API)' + (backendMissing ? ' [skipped: needs backend/, not in this checkout]' : ''), () => {

    beforeAll(async () => {
        // Clean up leftover CF resources from previous runs (crashed/interrupted tests
        // leave orphaned services on CF, causing wrangler ERRORs on next deploy)
        await cleanupCfResources()

        // Clear backend local state for a fresh database
        const localPersist = path.join(backendDir, '.local-persist')
        if (fs.existsSync(localPersist)) {
            fs.rmSync(localPersist, { recursive: true, force: true })
        }

        // Apply platform migrations (creates platform_users, users, resources tables)
        execSync(`node ${JSON.stringify(teenyBin)} deploy --local --root ${JSON.stringify(backendDir)} --yes`, {
            cwd: repoRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 60_000,
        })

        tmpDir = createTempProject()
        console.log(`Temp project: ${tmpDir}`)

        // Start backend — wrangler auto-reads backend/.dev.vars (CF credentials)
        // from the config directory when `config` is set.
        // persistTo matches teeny deploy's persist path so the D1 tables are available.
        backend = await unstable_dev(path.join(backendDir, 'src', 'index.ts'), {
            port: BACKEND_PORT,
            local: true,
            persistTo: localPersist,
            experimental: { disableExperimentalWarning: true },
            logLevel: 'log',
            config: path.join(backendDir, 'wrangler.jsonc'),
        })

        // Verify backend is up and detect proxy mode
        const health = await backend.fetch('/health')
        expect(health.status).toBe(200)
        const healthBody = await health.json() as any
        proxyMode = !!healthBody.proxyMode
        console.log('Proxy mode:', proxyMode)

        if (!proxyMode) {
            console.log('No CF credentials in backend/.dev.vars — proxy tests will be skipped')
            return
        }

        // Seed test user in USERS_DB — seed-user now returns a JWT
        const seedResp = await fetch(`${BACKEND_URL}/admin/seed-user`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${ADMIN_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email: TEST_USER_EMAIL }),
        })
        expect(seedResp.status).toBe(200)
        const user = await seedResp.json() as any
        TEST_USER_TOKEN = user.api_token
        console.log('Seeded user:', user.id, '(JWT token received)')
    }, 60_000)

    afterAll(async () => {
        if (proxyMode) {
            await cleanupCfResources()
        }
        if (backend) await backend.stop()
        if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        }
    })

    it('should reject invalid token in proxy mode', async (ctx) => {
        if (!proxyMode) ctx.skip()
        const resp = await fetch(`${BACKEND_URL}/client/v4/accounts/test/workers/subdomain`, {
            headers: { 'Authorization': 'Bearer invalid-token-xyz' },
        })
        expect(resp.status).toBe(401)
        const body = await resp.json() as any
        expect(body.errors[0].message).toContain('Invalid API token')
    })

    it('should accept valid user token in proxy mode', async (ctx) => {
        if (!proxyMode) ctx.skip()
        const resp = await fetch(`${BACKEND_URL}/client/v4/accounts/test/workers/subdomain`, {
            headers: { 'Authorization': `Bearer ${TEST_USER_TOKEN}` },
        })
        // Auth passes (not 401). The actual response may be 404 from CF
        // (account subdomain might not exist) but auth succeeded.
        expect(resp.status).not.toBe(401)
    })

    it('should deploy through proxy — first iteration', { timeout: 300_000 }, async (ctx) => {
        if (!proxyMode) ctx.skip()

        // Remove apiRoute so CLI treats this as first-time deploy
        // Must keep ADMIN_SERVICE_TOKEN as CLI requires it in .prod.vars
        fs.writeFileSync(path.join(tmpDir, '.prod.vars'), 'ADMIN_SERVICE_TOKEN=test-admin-token')
        // Remove infra.jsonc so there's no apiRoute
        const infraPath = path.join(tmpDir, 'infra.jsonc')
        if (fs.existsSync(infraPath)) fs.unlinkSync(infraPath)

        // Generate migrations
        const genResult = await teeny('generate --remote --clean', { timeout: 30_000 })
        console.log('generate stdout:', genResult.stdout)
        if (genResult.stderr) console.log('generate stderr:', genResult.stderr)

        // Full deploy + migrate flow through the proxy.
        // This runs: wrangler deploy → setup-db → apply migrations → re-deploy with config.
        let deployResult: { stdout: string, stderr: string }
        try {
            deployResult = await teeny('deploy --remote --yes --migrate --deploy', { timeout: 240_000 })
        } catch (e: any) {
            const stdout = e.stdout?.toString() || ''
            const stderr = e.stderr?.toString() || ''
            throw new Error(
                `Deploy command failed (exit code ${e.code}).\n` +
                `--- stdout ---\n${stdout}\n` +
                `--- stderr ---\n${stderr}`
            )
        }

        console.log('deploy stdout:', deployResult.stdout)
        if (deployResult.stderr) console.log('deploy stderr:', deployResult.stderr)

        // The deploy should be CLEAN — no [ERROR] from wrangler in stderr.
        // If wrangler shows errors (e.g., "Worker does not exist" code 10007),
        // it means leftover services weren't cleaned up or the proxy returned
        // an unexpected response. This is a real failure, not informational.
        const stderrErrors = deployResult.stderr
            .split('\n')
            .filter(line => line.includes('[ERROR]'))
        expect(stderrErrors, `Deploy stderr contains errors:\n${stderrErrors.join('\n')}`).toHaveLength(0)

        const combined = deployResult.stdout + deployResult.stderr

        // Verify the critical steps succeeded:
        // 1. Worker uploaded to CF
        expect(combined).toContain('Uploaded proxy-test-worker')
        // 2. Migrations applied successfully
        expect(combined).toContain('Applied 1 migrations successfully')
    })

    it('should re-deploy through proxy — detect no changes via D1 query proxy', { timeout: 120_000 }, async (ctx) => {
        if (!proxyMode) ctx.skip()

        // After the first deploy, set apiRoute in infra.jsonc pointing to worker-proxy.
        // This enables fetchDeployedMigrations() to reach the deployed worker
        // for setup-db/migrations fallback. The PRIMARY path, however, goes
        // through wrangler d1 execute → D1 query proxy → real CF D1 API.
        fs.writeFileSync(path.join(tmpDir, 'infra.jsonc'), JSON.stringify({apiRoute: `http://localhost:${BACKEND_PORT}/worker-proxy/proxy-test-worker`}, null, 2))

        // Generate migrations against remote — calls fetchDeployedMigrations()
        // which uses wrangler d1 execute → our D1 query proxy → CF D1 API.
        // This is the critical path Phase 12 adds to production.
        let genResult: { stdout: string, stderr: string }
        try {
            genResult = await teeny('generate --remote --clean', { timeout: 60_000 })
        } catch (e: any) {
            const stdout = e.stdout?.toString() || ''
            const stderr = e.stderr?.toString() || ''
            throw new Error(
                `Generate --remote failed (exit code ${e.code}).\n` +
                `--- stdout ---\n${stdout}\n` +
                `--- stderr ---\n${stderr}`
            )
        }
        console.log('re-deploy generate stdout:', genResult.stdout)
        if (genResult.stderr) console.log('re-deploy generate stderr:', genResult.stderr)

        const genOut = genResult.stdout + genResult.stderr
        // fetchDeployedMigrations should succeed and fetch existing migrations
        expect(genOut).toContain('Fetching deployed migrations')
        // No new migrations since config hasn't changed
        expect(genOut).toContain('No changes detected')

        // Migrate --remote should skip deployment (no changes)
        let migrateResult: { stdout: string, stderr: string }
        try {
            migrateResult = await teeny('deploy --remote --yes', { timeout: 60_000 })
        } catch (e: any) {
            const stdout = e.stdout?.toString() || ''
            const stderr = e.stderr?.toString() || ''
            throw new Error(
                `Migrate --remote re-deploy failed (exit code ${e.code}).\n` +
                `--- stdout ---\n${stdout}\n` +
                `--- stderr ---\n${stderr}`
            )
        }
        console.log('re-deploy migrate stdout:', migrateResult.stdout)
        if (migrateResult.stderr) console.log('re-deploy migrate stderr:', migrateResult.stderr)

        const migrateOut = migrateResult.stdout + migrateResult.stderr
        expect(migrateOut).toContain('Skipping worker deployment')
    })

})
