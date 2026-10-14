import {afterAll, afterEach, beforeEach, describe, expect, it} from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {AddressInfo} from 'node:net'
import {
    compareVersions,
    runWrangler,
    supportsTemporaryFlag,
    TemporaryNoticeFilter,
    versionAtLeast,
    WranglerCommandError,
    wranglerArgs,
    ALREADY_AUTHENTICATED_HINT,
    NOT_LOGGED_IN_HINT,
} from '../src/node/utils/wrangler-run'
import {
    findEnvCredential,
    findTemporaryAccountConfigProblems,
    isCachedAccountActive,
    parseClaimWithin,
    parseD1List,
    parseTemporaryAccountNotice,
    prepareTemporaryAccount,
    readTemporaryState,
    readWranglerTemporaryAccount,
    TEMPORARY_STATE_FILE,
    wranglerGlobalConfigDir,
    wranglerTemporaryAccountFile,
    writeTemporaryState,
} from '../src/node/temporary-account'
import {parseWhoamiJson, resolveDeployAccountId} from '../src/node/cloudflare-account'
import {CliContext, fetchWorkerAfterDeploy, GlobalCLIOptions, isDeploymentWarmupError, parseWrangler, WorkerFetchError} from '../src/node/cli-utils'
import {createLogger} from '../src/node/logger'

// ── fake wrangler ──
// A `wrangler` package whose bin logs its argv and answers from a scenario file, so the CLI's real
// spawn path (resolveWranglerPackage → node <bin> ...args) runs without touching Cloudflare.

const FAKE_BIN = `
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const scenarioFile = process.env.FAKE_WRANGLER_SCENARIO
const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'))
fs.appendFileSync(scenario.log, JSON.stringify(args) + '\\n')
const joined = args.join(' ')
const idx = scenario.responses.findIndex(r => joined.includes(r.match))
if (idx < 0) { process.stderr.write('fake wrangler: no response for ' + joined + '\\n'); process.exit(2) }
const r = scenario.responses[idx]
const counterFile = scenarioFile + '.count.' + idx
const count = fs.existsSync(counterFile) ? parseInt(fs.readFileSync(counterFile, 'utf8')) : 0
fs.writeFileSync(counterFile, String(count + 1))
if (r.failTimes && count < r.failTimes) {
    process.stderr.write(r.failStderr || '')
    process.exit(1)
}
if (r.writeCache) {
    const dir = path.join(process.env.XDG_CONFIG_HOME, '.wrangler')
    fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(path.join(dir, 'wrangler-temporary-account.toml'), r.writeCache, {mode: 0o600})
}
process.stdout.write(r.stdout || '')
process.stderr.write(r.stderr || '')
process.exit(r.exit || 0)
`

interface FakeResponse {
    match: string
    stdout?: string
    stderr?: string
    exit?: number
    failTimes?: number
    failStderr?: string
    writeCache?: string
}

function makeProject(opts: {wranglerVersion?: string, wranglerJsonc?: string, responses?: FakeResponse[]}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teeny-l3-test-'))
    const pkgDir = path.join(root, 'node_modules', 'wrangler')
    fs.mkdirSync(pkgDir, {recursive: true})
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({name: 'wrangler', version: opts.wranglerVersion ?? '4.150.0', bin: {wrangler: 'bin.cjs'}}))
    fs.writeFileSync(path.join(pkgDir, 'bin.cjs'), FAKE_BIN)
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'proj', private: true}))
    fs.writeFileSync(path.join(root, 'wrangler.jsonc'), opts.wranglerJsonc ?? defaultWranglerJsonc())
    const log = path.join(root, 'wrangler-calls.log')
    const scenarioFile = path.join(root, 'scenario.json')
    fs.writeFileSync(scenarioFile, JSON.stringify({log, responses: opts.responses ?? []}))
    return {
        root,
        scenarioFile,
        calls: (): string[][] => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [],
        setResponses: (responses: FakeResponse[]) => fs.writeFileSync(scenarioFile, JSON.stringify({log, responses})),
        wranglerJsonc: () => fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'),
    }
}

function defaultWranglerJsonc(extra = '', databaseId = 'TEENY_AUTO_CREATE') {
    return `{
    // comment kept
    "name": "my-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-10-01",${extra}
    "d1_databases": [
        {
            "binding": "PRIMARY_DB",
            "database_name": "my-app-db",
            "database_id": "${databaseId}",
            "migrations_dir": "migrations"
        }
    ]
}
`
}

const logger = createLogger('silent')
const savedEnv = {...process.env}
const tempDirs: string[] = []
let home: string

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teeny-l3-home-'))
    tempDirs.push(home)
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = path.join(home, '.config')
    process.env.TEENYBASE_CREDENTIALS = path.join(home, 'no-teeny-credentials.json')
    for (const k of ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_KEY', 'CLOUDFLARE_EMAIL', 'CF_EMAIL', 'CLOUDFLARE_ACCOUNT_ID', 'WRANGLER_API_ENVIRONMENT']) delete process.env[k]
})
afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
    Object.assign(process.env, savedEnv)
})
afterAll(() => {
    // leave temp dirs in os.tmpdir() (no deletes from tests); they are tiny
})

async function makeContext(root: string, scenarioFile: string, options: Partial<GlobalCLIOptions> = {}) {
    process.env.FAKE_WRANGLER_SCENARIO = scenarioFile
    const opts = {root, remote: true, ...options} as GlobalCLIOptions
    const wranglerConfig = await parseWrangler(root, opts, logger)
    return new CliContext(root, opts, wranglerConfig, logger)
}

const ACCOUNT_ID = '54a8b3f340ea84bd4ae038cda74c82fb'
const OTHER_ACCOUNT_ID = '91fc0000000000000000000000000000'
function cacheToml(id = ACCOUNT_ID, name = 'Mild Maraca', minutes = 50) {
    const exp = new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
    return `[account]\nid = "${id}"\nname = "${name}"\napiToken = "secret-token"\nexpiresAt = "${exp}"\n\n[claim]\nurl = "https://dash.cloudflare.com/claim-preview?claimToken=abc"\nexpiresAt = "${exp}"\n`
}
function notice(name = 'Mild Maraca', how = 'created') {
    return `Temporary account ready:\n\tAccount: ${name} (${how})\n\tClaim within: 60 minutes\n\tClaim URL: https://dash.cloudflare.com/claim-preview?claimToken=abc\n`
}

// ── pure helpers ──

describe('wrangler argv and versions', () => {
    it('compares versions numerically', () => {
        expect(compareVersions('4.102.0', '4.99.9')).toBeGreaterThan(0)
        expect(compareVersions('4.102.0', '4.102.0')).toBe(0)
        expect(compareVersions('4.101.9', '4.102.0')).toBeLessThan(0)
        expect(compareVersions('4.150.0-beta.1', '4.150.0')).toBe(0)
        expect(versionAtLeast('4.102.0', '4.102.0')).toBe(true)
        expect(versionAtLeast('4.80.0', '4.102.0')).toBe(false)
        expect(versionAtLeast('', '4.102.0')).toBe(false)
    })

    it('appends --temporary only to commands that accept it', () => {
        expect(wranglerArgs(['deploy', '--config=w.jsonc'], true)).toEqual(['deploy', '--config=w.jsonc', '--temporary'])
        expect(wranglerArgs(['d1', 'execute', 'DB', '--remote', '--command=SELECT 1'], true)).toEqual(['d1', 'execute', 'DB', '--remote', '--command=SELECT 1', '--temporary'])
        for (const cmd of [['d1', 'create', 'x'], ['d1', 'list', '--json'], ['d1', 'export', 'DB'], ['secret', 'bulk', 'f'], ['deployments', 'list', '--json']]) {
            expect(wranglerArgs(cmd, true).at(-1)).toBe('--temporary')
        }
        expect(wranglerArgs(['deploy', '--dry-run', '--outdir=x'], true)).toEqual(['deploy', '--dry-run', '--outdir=x'])
        for (const cmd of [['dev'], ['types'], ['whoami', '--json'], ['login']]) {
            expect(supportsTemporaryFlag(cmd)).toBe(false)
            expect(wranglerArgs(cmd, true)).toEqual(cmd)
        }
        expect(wranglerArgs(['deploy', '--temporary'], true)).toEqual(['deploy', '--temporary'])
        expect(wranglerArgs(['deploy'], false)).toEqual(['deploy'])
    })

    it('filters the repeated temporary-account block from live output, across chunk boundaries', () => {
        const f = new TemporaryNoticeFilter()
        const text = 'Solving proof-of-work challenge...\n' + notice() + 'Continuing means you accept Cloudflare\'s Terms of Service (x) and Privacy Policy (y).\nUploaded my-app (1.2 sec)\n  https://my-app.mild-maraca.workers.dev\n'
        let out = ''
        for (let i = 0; i < text.length; i += 7) out += f.push(text.slice(i, i + 7))
        out += f.flush()
        expect(out).toBe('Solving proof-of-work challenge...\nUploaded my-app (1.2 sec)\n  https://my-app.mild-maraca.workers.dev\n')
        expect(out).not.toContain('claimToken')
    })
})

describe('temporary account parsing', () => {
    it('parses the notice wrangler prints and its "Claim within" text', () => {
        expect(parseTemporaryAccountNotice('noise\n' + notice('Humane Strand', 'reused'))).toEqual({
            name: 'Humane Strand', created: false, claimWithin: '60 minutes',
            claimUrl: 'https://dash.cloudflare.com/claim-preview?claimToken=abc',
        })
        expect(parseTemporaryAccountNotice('nothing here')).toBeUndefined()
        expect(parseClaimWithin('59 minutes')).toBe(59 * 60_000)
        expect(parseClaimWithin('1 hour')).toBe(3_600_000)
        expect(parseClaimWithin('soon')).toBeUndefined()
    })

    it('resolves wrangler\'s global config dir like wrangler does', () => {
        const h = fs.mkdtempSync(path.join(os.tmpdir(), 'teeny-l3-xdg-'))
        expect(wranglerGlobalConfigDir({}, 'linux', h)).toBe(path.join(h, '.config', '.wrangler'))
        expect(wranglerGlobalConfigDir({XDG_CONFIG_HOME: '/x/cfg'}, 'linux', h)).toBe('/x/cfg/.wrangler')
        expect(wranglerGlobalConfigDir({}, 'darwin', h)).toBe(path.join(h, 'Library', 'Preferences', '.wrangler'))
        expect(wranglerTemporaryAccountFile({WRANGLER_API_ENVIRONMENT: 'staging'}, 'linux', h)).toBe(path.join(h, '.config', '.wrangler', 'wrangler-temporary-account.staging.toml'))
        fs.mkdirSync(path.join(h, '.wrangler'))
        expect(wranglerGlobalConfigDir({XDG_CONFIG_HOME: '/x/cfg'}, 'linux', h)).toBe(path.join(h, '.wrangler'))
    })

    it('reads the cached account without the API token, and checks expiry', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teeny-l3-cache-'))
        const file = path.join(dir, 'wrangler-temporary-account.toml')
        expect(readWranglerTemporaryAccount(file)).toBeUndefined()
        fs.writeFileSync(file, cacheToml())
        const acc = readWranglerTemporaryAccount(file)!
        expect(acc.id).toBe(ACCOUNT_ID)
        expect(acc.name).toBe('Mild Maraca')
        expect(JSON.stringify(acc)).not.toContain('secret-token')
        expect(isCachedAccountActive(acc)).toBe(true)
        fs.writeFileSync(file, cacheToml(ACCOUNT_ID, 'Mild Maraca', -1))
        expect(isCachedAccountActive(readWranglerTemporaryAccount(file))).toBe(false)
        fs.writeFileSync(file, '[account]\nid = "x"\n')
        expect(readWranglerTemporaryAccount(file)).toBeUndefined()
        fs.writeFileSync(file, 'not = toml = at all')
        expect(readWranglerTemporaryAccount(file)).toBeUndefined()
    })

    it('stores .teeny/temporary.json readable only by the user', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teeny-l3-state-'))
        expect(readTemporaryState(root)).toBeUndefined()
        const state = {accountId: ACCOUNT_ID, accountName: 'Mild Maraca', claimUrl: 'https://c', expiresAt: '2026-10-13T10:00:00Z', updatedAt: 'now'}
        fs.mkdirSync(path.join(root, '.teeny'))
        fs.writeFileSync(path.join(root, TEMPORARY_STATE_FILE), '{}', {mode: 0o644})
        writeTemporaryState(root, state)
        expect(readTemporaryState(root)).toEqual(state)
        if (process.platform !== 'win32') expect(fs.statSync(path.join(root, TEMPORARY_STATE_FILE)).mode & 0o777).toBe(0o600)
    })

    it('finds bindings temporary accounts can\'t deploy', () => {
        const ok = {name: 'a', d1_databases: [{binding: 'DB', database_name: 'a-db'}], kv_namespaces: [{binding: 'KV'}], durable_objects: {bindings: []}, vars: {X: '1'}}
        expect(findTemporaryAccountConfigProblems(ok)).toEqual([])
        const bad = {
            ...ok,
            r2_buckets: [{binding: 'B', bucket_name: 'TEENY_AUTO_CREATE'}],
            routes: [{pattern: 'api.example.com', custom_domain: true}],
            ai: {binding: 'AI'},
            env: {staging: {r2_buckets: [{binding: 'B'}], d1_databases: [{binding: 'DB', database_name: 'staging-db'}]}},
        }
        const problems = findTemporaryAccountConfigProblems(bad)
        expect(problems.some(p => p.startsWith('r2_buckets'))).toBe(true)
        expect(problems.some(p => p.startsWith('env.staging.r2_buckets'))).toBe(true)
        expect(problems.some(p => p.startsWith('routes'))).toBe(true)
        expect(problems.some(p => p.startsWith('ai'))).toBe(true)
        expect(problems.some(p => p.includes('2 databases'))).toBe(true)
        expect(findTemporaryAccountConfigProblems({...ok, r2_buckets: []})).toEqual([])
    })

    it('detects credentials in the environment the way wrangler does', () => {
        expect(findEnvCredential({})).toBeUndefined()
        expect(findEnvCredential({CLOUDFLARE_API_TOKEN: 't'})).toBe('CLOUDFLARE_API_TOKEN')
        expect(findEnvCredential({CF_API_TOKEN: 't'})).toBe('CF_API_TOKEN')
        expect(findEnvCredential({CLOUDFLARE_API_KEY: 'k'})).toBeUndefined() // a global key needs the email too
        expect(findEnvCredential({CLOUDFLARE_API_KEY: 'k', CLOUDFLARE_EMAIL: 'e'})).toBe('CLOUDFLARE_API_KEY')
        expect(findEnvCredential({CLOUDFLARE_ACCOUNT_ID: 'a'})).toBeUndefined()
    })

    it('parses `d1 list --json` and `whoami --json`', () => {
        expect(parseD1List('[{"uuid":"u1","name":"a"},{"name":"no-uuid"}]')).toEqual([{uuid: 'u1', name: 'a'}])
        expect(parseD1List('warning line\n[]\n')).toEqual([])
        expect(() => parseD1List('oops')).toThrow(/d1 list/)
        expect(parseWhoamiJson('{"loggedIn":true,"email":"e@x","accounts":[{"id":"1","name":"A"}]}')).toEqual({loggedIn: true, email: 'e@x', accounts: [{id: '1', name: 'A'}]})
        expect(parseWhoamiJson('{"loggedIn": false}')).toEqual({loggedIn: false, email: undefined, accounts: []})
        expect(parseWhoamiJson('Getting User settings...')).toBeUndefined()
    })
})

// ── runWrangler against the fake wrangler ──

describe('runWrangler', () => {
    it('spawns the project\'s wrangler with --temporary appended and captures output', async () => {
        const p = makeProject({responses: [{match: 'd1 list', stdout: '[]', stderr: notice()}]})
        process.env.FAKE_WRANGLER_SCENARIO = p.scenarioFile
        const res = await runWrangler({root: p.root, args: ['d1', 'list', '--json'], logger, temporary: true, echo: false})
        expect(res.stdout).toBe('[]')
        expect(res.stderr).toContain('Temporary account ready')
        expect(p.calls()).toEqual([['d1', 'list', '--json', '--temporary']])
    })

    it('retries the new-account code 10000 error in temporary mode only', async () => {
        const failStderr = '✘ [ERROR] A request to the Cloudflare API (/accounts/x/d1/database) failed.\n  Authentication error [code: 10000]\n'
        const p = makeProject({responses: [{match: 'd1 create', failTimes: 2, failStderr, stdout: 'ok'}]})
        process.env.FAKE_WRANGLER_SCENARIO = p.scenarioFile
        const res = await runWrangler({root: p.root, args: ['d1', 'create', 'db'], logger, temporary: true, echo: false, retryDelaysMs: [1, 1, 1]})
        expect(res.stdout).toBe('ok')
        expect(p.calls().length).toBe(3)

        const q = makeProject({responses: [{match: 'd1 create', failTimes: 5, failStderr, stdout: 'ok'}]})
        process.env.FAKE_WRANGLER_SCENARIO = q.scenarioFile
        await expect(runWrangler({root: q.root, args: ['d1', 'create', 'db'], logger, temporary: false, echo: false, retryDelaysMs: [1, 1]})).rejects.toBeInstanceOf(WranglerCommandError)
        expect(q.calls().length).toBe(1)

        const r = makeProject({responses: [{match: 'd1 create', failTimes: 5, failStderr, stdout: 'ok'}]})
        process.env.FAKE_WRANGLER_SCENARIO = r.scenarioFile
        const err = await runWrangler({root: r.root, args: ['d1', 'create', 'db'], logger, temporary: true, echo: false, retryDelaysMs: [1, 1]}).catch(e => e)
        expect(err).toBeInstanceOf(WranglerCommandError)
        expect(err.message).toContain('Authentication error [code: 10000]')
        expect(r.calls().length).toBe(3) // first try + 2 retries
    })

    it('redacts the claim URL token from failed commands', async () => {
        const p = makeProject({responses: [{match: 'deployments', exit: 1, stderr: notice() + '✘ [ERROR] boom [code: 7000]\n'}]})
        process.env.FAKE_WRANGLER_SCENARIO = p.scenarioFile
        const err = await runWrangler({root: p.root, args: ['deployments', 'list'], logger, temporary: true, echo: false}).catch(e => e)
        expect(err).toBeInstanceOf(WranglerCommandError)
        for (const text of [err.message, err.output, err.stderr, err.stdout]) expect(text).not.toContain('claimToken=abc')
        expect(err.output).toContain('claimToken=<redacted>')
    })

    it('turns wrangler\'s login errors into teeny guidance', async () => {
        const p = makeProject({responses: [
            {match: 'deployments', exit: 1, stderr: '✘ [ERROR] In a non-interactive environment, it\'s necessary to set a CLOUDFLARE_API_TOKEN environment variable for wrangler to work.\n'},
            {match: 'deploy', exit: 1, stderr: '✘ [ERROR] You\'re already authenticated with Cloudflare, so `--temporary` can\'t be used. Temporary preview accounts are only for unauthenticated use.\n'},
        ]})
        process.env.FAKE_WRANGLER_SCENARIO = p.scenarioFile
        const a = await runWrangler({root: p.root, args: ['deploy'], logger, temporary: true, echo: false}).catch(e => e)
        expect(a.message).toBe(ALREADY_AUTHENTICATED_HINT)
        const b = await runWrangler({root: p.root, args: ['deployments', 'list'], logger, echo: false}).catch(e => e)
        expect(b.message).toContain(NOT_LOGGED_IN_HINT)
    })
})

// ── prepareTemporaryAccount ──

describe('prepareTemporaryAccount', () => {
    const listCreated = (dbs = '[]'): FakeResponse => ({match: 'd1 list', stdout: dbs, stderr: notice(), writeCache: cacheToml()})

    it('requires wrangler 4.102+ before any wrangler call', async () => {
        const p = makeProject({wranglerVersion: '4.101.0', responses: [listCreated()]})
        const c = await makeContext(p.root, p.scenarioFile, {temporary: true, yes: true})
        await expect(prepareTemporaryAccount(c)).rejects.toThrow(/wrangler 4\.102\.0 or newer.*4\.101\.0/)
        expect(p.calls()).toEqual([])
    })

    it('refuses R2 and other unsupported bindings before any wrangler call', async () => {
        const extra = '\n    "r2_buckets": [{"binding": "FILES", "bucket_name": "TEENY_AUTO_CREATE"}],'
        const p = makeProject({wranglerJsonc: defaultWranglerJsonc(extra), responses: [listCreated()]})
        const c = await makeContext(p.root, p.scenarioFile, {temporary: true, yes: true})
        await expect(prepareTemporaryAccount(c)).rejects.toThrow(/r2_buckets: R2 buckets aren't available on temporary accounts/)
        expect(p.calls()).toEqual([])
    })

    it('refuses when Cloudflare credentials are set in the environment', async () => {
        const p = makeProject({responses: [listCreated()]})
        const c = await makeContext(p.root, p.scenarioFile, {temporary: true, yes: true})
        process.env.CLOUDFLARE_API_TOKEN = 'x'
        await expect(prepareTemporaryAccount(c)).rejects.toThrow(/CLOUDFLARE_API_TOKEN is set/)
        expect(p.calls()).toEqual([])
    })

    it('refuses a config that already points at a non-temporary account', async () => {
        const p = makeProject({wranglerJsonc: defaultWranglerJsonc(`\n    "account_id": "${OTHER_ACCOUNT_ID}",`), responses: [listCreated()]})
        const c = await makeContext(p.root, p.scenarioFile, {temporary: true, yes: true})
        await expect(prepareTemporaryAccount(c)).rejects.toThrow(/isn't a temporary account teeny deployed to/)
        expect(p.calls()).toEqual([])
    })

    it('asks before creating an account (Cloudflare terms) and fails fast without a terminal', async () => {
        const p = makeProject({responses: [listCreated()]})
        const c = await makeContext(p.root, p.scenarioFile, {temporary: true})
        await expect(prepareTemporaryAccount(c)).rejects.toThrow(/Pass --yes to accept Cloudflare's terms/)
        expect(p.calls()).toEqual([])
    })

    it('first run: records the account, writes account_id, keeps the placeholder database', async () => {
        const p = makeProject({responses: [listCreated()]})
        const c = await makeContext(p.root, p.scenarioFile, {temporary: true, yes: true})
        const account = await prepareTemporaryAccount(c)
        expect(account).toMatchObject({id: ACCOUNT_ID, name: 'Mild Maraca', created: true})
        expect(p.calls()[0].slice(0, 3)).toEqual(['d1', 'list', '--json'])
        expect(p.calls()[0].at(-1)).toBe('--temporary')
        const jsonc = p.wranglerJsonc()
        expect(jsonc).toContain(`"account_id": "${ACCOUNT_ID}"`)
        expect(jsonc).toContain('// comment kept')
        expect(jsonc).toContain('"database_id": "TEENY_AUTO_CREATE"')
        expect(c.wranglerConfig.config.config.account_id).toBe(ACCOUNT_ID)
        const state = readTemporaryState(p.root)!
        expect(state).toMatchObject({accountId: ACCOUNT_ID, accountName: 'Mild Maraca', claimUrl: 'https://dash.cloudflare.com/claim-preview?claimToken=abc'})
        expect(Date.parse(state.expiresAt)).toBeGreaterThan(Date.now())
        expect(c.temporaryAccount?.id).toBe(ACCOUNT_ID)
    })

    it('reports "created" when a 10000 retry made wrangler print "reused" for the account it just created', async () => {
        const p = makeProject({responses: [{match: 'd1 list', stdout: '[]', stderr: notice('Mild Maraca', 'reused'), writeCache: cacheToml()}]})
        const c = await makeContext(p.root, p.scenarioFile, {temporary: true, yes: true})
        expect((await prepareTemporaryAccount(c)).created).toBe(true)
    })

    it('second run on the same account keeps the database and does not ask again', async () => {
        const dbId = '0d59558f-1904-4a9a-affd-d8f7b0d94822'
        const p = makeProject({wranglerJsonc: defaultWranglerJsonc(`\n    "account_id": "${ACCOUNT_ID}",`, dbId), responses: [
            {match: 'd1 list', stdout: `[{"uuid":"${dbId}","name":"my-app-db"}]`, stderr: notice('Mild Maraca', 'reused')},
        ]})
        const cacheDir = path.join(process.env.XDG_CONFIG_HOME!, '.wrangler')
        fs.mkdirSync(cacheDir, {recursive: true})
        fs.writeFileSync(path.join(cacheDir, 'wrangler-temporary-account.toml'), cacheToml())
        writeTemporaryState(p.root, {accountId: ACCOUNT_ID, accountName: 'Mild Maraca', claimUrl: 'https://c', expiresAt: new Date(Date.now() + 3e6).toISOString(), url: 'https://my-app.mild-maraca.workers.dev', updatedAt: 'x'})
        fs.writeFileSync(path.join(p.root, 'infra.jsonc'), '{"apiRoute": "https://my-app.mild-maraca.workers.dev"}')
        const c = await makeContext(p.root, p.scenarioFile, {temporary: true}) // no --yes: account is cached, no terms prompt
        const account = await prepareTemporaryAccount(c)
        expect(account.created).toBe(false)
        expect(p.wranglerJsonc()).toContain(`"database_id": "${dbId}"`)
        expect(fs.readFileSync(path.join(p.root, 'infra.jsonc'), 'utf8')).toContain('apiRoute')
        expect(readTemporaryState(p.root)?.url).toBe('https://my-app.mild-maraca.workers.dev')
        expect(c.databaseIdChanged).toBe(false)
    })

    it('after the account changed: resets database_id and apiRoute, updates account_id', async () => {
        const oldDb = '0d59558f-1904-4a9a-affd-d8f7b0d94822'
        const p = makeProject({wranglerJsonc: defaultWranglerJsonc(`\n    "account_id": "${OTHER_ACCOUNT_ID}",`, oldDb), responses: [listCreated()]})
        writeTemporaryState(p.root, {accountId: OTHER_ACCOUNT_ID, accountName: 'Humane Strand', claimUrl: 'https://old', expiresAt: '2026-01-01T00:00:00Z', url: 'https://my-app.humane-strand.workers.dev', updatedAt: 'x'})
        fs.writeFileSync(path.join(p.root, 'infra.jsonc'), '{\n  "apiRoute": "https://my-app.humane-strand.workers.dev"\n}')
        const c = await makeContext(p.root, p.scenarioFile, {temporary: true, yes: true})
        await prepareTemporaryAccount(c)
        const jsonc = p.wranglerJsonc()
        expect(jsonc).toContain('"database_id": "TEENY_AUTO_CREATE"')
        expect(jsonc).toContain(`"account_id": "${ACCOUNT_ID}"`)
        expect(jsonc).not.toContain(OTHER_ACCOUNT_ID)
        expect(fs.readFileSync(path.join(p.root, 'infra.jsonc'), 'utf8')).not.toContain('apiRoute')
        expect(await c.getApiRoute(true)).toBeUndefined()
        expect(readTemporaryState(p.root)).toMatchObject({accountId: ACCOUNT_ID, accountName: 'Mild Maraca'})
        expect(readTemporaryState(p.root)?.url).toBeUndefined()
        expect(c.wranglerConfig.db.database_id).toBe('TEENY_AUTO_CREATE')
    })

    it('same account but the database is gone: resets database_id, keeps the worker URL', async () => {
        const oldDb = '0d59558f-1904-4a9a-affd-d8f7b0d94822'
        const p = makeProject({wranglerJsonc: defaultWranglerJsonc(`\n    "account_id": "${ACCOUNT_ID}",`, oldDb), responses: [listCreated()]})
        writeTemporaryState(p.root, {accountId: ACCOUNT_ID, accountName: 'Mild Maraca', claimUrl: 'https://c', expiresAt: new Date(Date.now() + 3e6).toISOString(), updatedAt: 'x'})
        fs.writeFileSync(path.join(p.root, 'infra.jsonc'), '{"apiRoute": "https://my-app.mild-maraca.workers.dev"}')
        const c = await makeContext(p.root, p.scenarioFile, {temporary: true, yes: true})
        await prepareTemporaryAccount(c)
        expect(p.wranglerJsonc()).toContain('"database_id": "TEENY_AUTO_CREATE"')
        expect(await c.getApiRoute(true)).toBe('https://my-app.mild-maraca.workers.dev')
    })

    it('adopts an existing database with the configured name (one database per temporary account)', async () => {
        const dbId = '11111111-2222-3333-4444-555555555555'
        const p = makeProject({responses: [listCreated(`[{"uuid":"${dbId}","name":"my-app-db"}]`)]})
        const c = await makeContext(p.root, p.scenarioFile, {temporary: true, yes: true})
        await prepareTemporaryAccount(c)
        expect(p.wranglerJsonc()).toContain(`"database_id": "${dbId}"`)
        expect(c.wranglerConfig.db.database_id).toBe(dbId)
        expect(c.databaseIdChanged).toBe(true)
    })

    it('explains the one-database limit when another database already exists', async () => {
        const p = makeProject({responses: [listCreated('[{"uuid":"11111111-2222-3333-4444-555555555555","name":"other-app-db"}]')]})
        const c = await makeContext(p.root, p.scenarioFile, {temporary: true, yes: true})
        await expect(prepareTemporaryAccount(c)).rejects.toThrow(/allow one D1 database.*'other-app-db'/)
        expect(p.wranglerJsonc()).toContain('"database_id": "TEENY_AUTO_CREATE"')
    })

    it('falls back to wrangler\'s printed notice when its cache file is unreadable', async () => {
        const p = makeProject({responses: [{match: 'd1 list', stdout: '[]', stderr: notice('Quiet Fern')}]})
        const c = await makeContext(p.root, p.scenarioFile, {temporary: true, yes: true})
        const account = await prepareTemporaryAccount(c)
        expect(account).toMatchObject({id: undefined, name: 'Quiet Fern', created: true})
        expect(p.wranglerJsonc()).not.toContain('"account_id"')
        expect(Date.parse(account.expiresAt) - Date.now()).toBeGreaterThan(59 * 60_000)
    })
})

// ── own-account resolution (B15) ──

describe('resolveDeployAccountId', () => {
    it('uses account_id from the config, then CLOUDFLARE_ACCOUNT_ID, without calling wrangler', async () => {
        const p = makeProject({wranglerJsonc: defaultWranglerJsonc(`\n    "account_id": "${OTHER_ACCOUNT_ID}",`)})
        const c = await makeContext(p.root, p.scenarioFile)
        expect(await resolveDeployAccountId(c, true)).toBe(OTHER_ACCOUNT_ID)
        const q = makeProject({})
        process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_ID
        const d = await makeContext(q.root, q.scenarioFile)
        expect(await resolveDeployAccountId(d, true)).toBe(ACCOUNT_ID)
        expect(q.wranglerJsonc()).not.toContain('account_id')
        expect([...p.calls(), ...q.calls()]).toEqual([])
    })

    it('uses the only account of the wrangler login and saves it', async () => {
        const p = makeProject({responses: [{match: 'whoami', stdout: JSON.stringify({loggedIn: true, accounts: [{id: ACCOUNT_ID, name: 'Me'}]})}]})
        const c = await makeContext(p.root, p.scenarioFile)
        expect(await resolveDeployAccountId(c, true)).toBe(ACCOUNT_ID)
        expect(p.wranglerJsonc()).toContain(`"account_id": "${ACCOUNT_ID}"`)
        expect(p.calls()[0].slice(0, 2)).toEqual(['whoami', '--json'])
        expect(p.calls()[0]).not.toContain('--temporary')
    })

    it('with --yes and several accounts: fails listing them', async () => {
        const p = makeProject({responses: [{match: 'whoami', stdout: JSON.stringify({loggedIn: true, accounts: [{id: ACCOUNT_ID, name: 'Me'}, {id: OTHER_ACCOUNT_ID, name: 'Team'}]})}]})
        const c = await makeContext(p.root, p.scenarioFile)
        await expect(resolveDeployAccountId(c, true)).rejects.toThrow(new RegExp(`2 accounts[\\s\\S]*Me: ${ACCOUNT_ID}[\\s\\S]*Team: ${OTHER_ACCOUNT_ID}`))
        expect(p.wranglerJsonc()).not.toContain('"account_id"')
    })

    it('not logged in: points to wrangler login and --temporary', async () => {
        const p = makeProject({responses: [{match: 'whoami', exit: 1, stdout: '{"loggedIn":false}'}]})
        const c = await makeContext(p.root, p.scenarioFile)
        await expect(resolveDeployAccountId(c, true)).rejects.toThrow(NOT_LOGGED_IN_HINT)
    })

    it('wrangler without `whoami --json` (< 4.65): asks for account_id', async () => {
        const p = makeProject({wranglerVersion: '4.63.0'})
        const c = await makeContext(p.root, p.scenarioFile)
        await expect(resolveDeployAccountId(c, true)).rejects.toThrow(/account_id is not set.*4\.65\.0/)
        expect(p.calls()).toEqual([])
    })
})

// ── first call to a freshly deployed worker (B16) ──

describe('fetchWorkerAfterDeploy', () => {
    async function serve(statuses: (number | 'drop')[]) {
        let i = 0
        const server = http.createServer((req, res) => {
            const s = statuses[Math.min(i++, statuses.length - 1)]
            if (s === 'drop') return req.socket.destroy()
            res.writeHead(s, {'Content-Type': 'application/json'})
            res.end(s === 200 ? '{"ok":true}' : JSON.stringify({message: s === 403 ? 'Forbidden' : 'Error', code: s}))
        })
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
        return {url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, count: () => i, close: () => server.close()}
    }
    async function remoteContext(url: string) {
        const p = makeProject({})
        fs.writeFileSync(path.join(p.root, '.prod.vars'), 'ADMIN_SERVICE_TOKEN=t\n')
        fs.writeFileSync(path.join(p.root, 'infra.jsonc'), JSON.stringify({apiRoute: url}))
        return makeContext(p.root, p.scenarioFile)
    }

    it('retries 403/404/dropped connections until the new deployment answers', async () => {
        const s = await serve([403, 404, 'drop', 200])
        const c = await remoteContext(s.url)
        expect(await fetchWorkerAfterDeploy(c, '/api/v1/setup-db', {method: 'POST'}, {delaysMs: [1, 1, 1, 1]})).toEqual({ok: true})
        expect(s.count()).toBe(4)
        s.close()
    })

    it('does not retry real errors, and gives up after the budget', async () => {
        const s = await serve([500])
        const c = await remoteContext(s.url)
        const err = await fetchWorkerAfterDeploy(c, '/api/v1/setup-db', {method: 'POST'}, {delaysMs: [1, 1]}).catch(e => e)
        expect(err).toBeInstanceOf(WorkerFetchError)
        expect(err.status).toBe(500)
        expect(s.count()).toBe(1)
        s.close()

        const t = await serve([403])
        const d = await remoteContext(t.url)
        const err2 = await fetchWorkerAfterDeploy(d, '/api/v1/setup-db', {method: 'POST'}, {delaysMs: [1, 1]}).catch(e => e)
        expect(err2.status).toBe(403)
        expect(err2.message).toContain('Response: Forbidden') // the body's message, not "Forbidden undefined"
        expect(err2.message).not.toContain('undefined')
        expect(t.count()).toBe(3)
        t.close()

        // non-idempotent requests: only statuses that prove the request wasn't processed are retried
        const u = await serve(['drop', 200])
        const e3 = await remoteContext(u.url)
        await expect(fetchWorkerAfterDeploy(e3, '/api/v1/migrations', {method: 'POST'}, {delaysMs: [1, 1], networkErrors: false})).rejects.toThrow(/fetch failed/)
        expect(u.count()).toBe(1)
        u.close()
    })

    it('summarises HTML error pages instead of dumping them', async () => {
        const server = http.createServer((req, res) => {
            res.writeHead(404, {'Content-Type': 'text/html'})
            res.end('<!DOCTYPE html>\n<html><head><title>Page not found</title></head><body>' + 'x'.repeat(5000) + '</body></html>')
        })
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
        const c = await remoteContext(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
        const err = await fetchWorkerAfterDeploy(c, '/api/v1/migrations', {method: 'POST'}, {delaysMs: [1]}).catch(e => e)
        expect(err.status).toBe(404)
        expect(err.message).toMatch(/Status: 404, Response: HTML page "Page not found"$/)
        server.close()
    })

    it('classifies warm-up errors', () => {
        expect(isDeploymentWarmupError(new WorkerFetchError('x', 401))).toBe(true)
        expect(isDeploymentWarmupError(new WorkerFetchError('x', 500))).toBe(false)
        expect(isDeploymentWarmupError(new WorkerFetchError('x', 500), true, true)).toBe(true)
        expect(isDeploymentWarmupError(new TypeError('fetch failed'), false)).toBe(false)
        expect(isDeploymentWarmupError(new TypeError('fetch failed'))).toBe(true)
        expect(isDeploymentWarmupError(Object.assign(new Error('t'), {name: 'TimeoutError'}))).toBe(true)
        expect(isDeploymentWarmupError(new Error('other'))).toBe(false)
    })
})
