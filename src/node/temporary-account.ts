import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import colors from 'picocolors'
import TOML from 'smol-toml'
import {ask} from './prompts'
import {readableRelative} from './utils'
import {
    apiRouteKey,
    AUTO_CREATE,
    CliContext,
    parsePlaceholder,
    parseWrangler,
    projectConfigFile,
    removeProjectConfigKey,
    replacePlaceholderInConfig,
    writeAccountIdToWranglerConfig,
} from './cli-utils'
import {resolveWranglerPackage} from './utils/wrangler-bin'
import {versionAtLeast, WRANGLER_MIN_TEMPORARY, withMinimalWranglerConfig} from './utils/wrangler-run'

// `teeny <command> --temporary`: deploy to a Cloudflare temporary account (wrangler `--temporary`,
// https://developers.cloudflare.com/workers/platform/claim-deployments/). No login or signup; the
// account lives 60 minutes from its creation unless someone claims it with the claim URL.

export const CLOUDFLARE_TERMS_URL = 'https://www.cloudflare.com/terms/'
export const CLOUDFLARE_PRIVACY_URL = 'https://www.cloudflare.com/privacypolicy/'
export const TEMPORARY_TERMS_NOTICE = `A temporary Cloudflare account will be created for this deploy. Continuing means you accept Cloudflare's Terms of Service (${CLOUDFLARE_TERMS_URL}) and Privacy Policy (${CLOUDFLARE_PRIVACY_URL}).`

/** The temporary account wrangler is using (from its cache file and/or its printed notice). */
export interface TemporaryAccountInfo {
    /** Undefined only if wrangler's cache file couldn't be read. */
    id?: string
    name: string
    claimUrl: string
    /** ISO time when the account (and the claim URL) expire. */
    expiresAt: string
    /** Created by this command (false = reused from wrangler's cache). */
    created: boolean
}

// ── wrangler's cache of the temporary account ──

/**
 * wrangler's global config directory, resolved the way wrangler 4.150 does it
 * (`getGlobalConfigPath` + `xdgAppPaths('.wrangler').config()`): a legacy `~/.wrangler` directory wins
 * if it exists, else `<XDG config dir>/.wrangler`, where the XDG config dir is `$XDG_CONFIG_HOME` or
 * `~/.config` (Linux), `~/Library/Preferences` (macOS), `%APPDATA%\xdg.config` (Windows).
 */
export function wranglerGlobalConfigDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
    const legacy = path.join(home, '.wrangler')
    try {
        if (fs.statSync(legacy).isDirectory()) return legacy
    } catch { /* no legacy dir */ }
    let configHome = env.XDG_CONFIG_HOME
    if (!configHome) {
        if (platform === 'darwin') configHome = path.join(home, 'Library', 'Preferences')
        else if (platform === 'win32') configHome = path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'xdg.config')
        else configHome = path.join(home, '.config')
    }
    return path.join(configHome, '.wrangler')
}

/** Path of wrangler's temporary account cache (`wrangler-temporary-account[.staging].toml`). */
export function wranglerTemporaryAccountFile(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
    const environment = env.WRANGLER_API_ENVIRONMENT === 'staging' ? 'staging' : 'production'
    const file = environment === 'production' ? 'wrangler-temporary-account.toml' : `wrangler-temporary-account.${environment}.toml`
    return path.join(wranglerGlobalConfigDir(env, platform, home), file)
}

export interface CachedTemporaryAccount {
    id: string
    name: string
    expiresAt: string
    claimUrl: string
    claimExpiresAt: string
}

/**
 * Read wrangler's cached temporary account (never its API token). Undefined if the file is missing
 * or doesn't have the expected fields. This is a wrangler-internal file: callers must cope with
 * undefined (teeny falls back to what wrangler prints).
 */
export function readWranglerTemporaryAccount(file: string = wranglerTemporaryAccountFile()): CachedTemporaryAccount | undefined {
    let raw: string
    try {
        raw = fs.readFileSync(file, 'utf8')
    } catch {
        return undefined
    }
    let data: any
    try {
        data = TOML.parse(raw)
    } catch {
        return undefined
    }
    const id = data?.account?.id, name = data?.account?.name, expiresAt = data?.account?.expiresAt
    const claimUrl = data?.claim?.url, claimExpiresAt = data?.claim?.expiresAt
    if (![id, name, expiresAt, claimUrl, claimExpiresAt].every(v => typeof v === 'string' && v)) return undefined
    return {id, name, expiresAt, claimUrl, claimExpiresAt}
}

/** Same rule as wrangler: reused only while both the account and the claim URL are unexpired. */
export function isCachedAccountActive(account: CachedTemporaryAccount | undefined, now = Date.now()): boolean {
    if (!account) return false
    const a = Date.parse(account.expiresAt), b = Date.parse(account.claimExpiresAt)
    return Number.isFinite(a) && Number.isFinite(b) && a > now && b > now
}

// ── wrangler's printed notice ──

export interface TemporaryAccountNotice {
    name: string
    created: boolean
    claimWithin: string
    claimUrl: string
}

/**
 * Parse the block wrangler prints (to stderr) on every `--temporary` call:
 * ```
 * Temporary account ready:
 * 	Account: Humane Strand (created)
 * 	Claim within: 60 minutes
 * 	Claim URL: https://dash.cloudflare.com/claim-preview?claimToken=...
 * ```
 */
export function parseTemporaryAccountNotice(output: string): TemporaryAccountNotice | undefined {
    const text = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    const m = text.match(/Temporary account ready:\s*\r?\n\s*Account:\s*(.+?)\s*\((created|reused)\)\s*\r?\n\s*Claim within:\s*(.+?)\s*\r?\n\s*Claim URL:\s*(\S+)/)
    if (!m) return undefined
    return {name: m[1], created: m[2] === 'created', claimWithin: m[3], claimUrl: m[4]}
}

/** "59 minutes" / "1 hour" / "30 seconds" (date-fns formatDistanceToNowStrict) → milliseconds. */
export function parseClaimWithin(text: string): number | undefined {
    const m = text.trim().match(/^(\d+)\s+(second|minute|hour|day)s?$/)
    if (!m) return undefined
    const unit = {second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000}[m[2] as 'second' | 'minute' | 'hour' | 'day']
    return parseInt(m[1], 10) * unit
}

// ── .teeny/temporary.json ──

export const TEMPORARY_STATE_FILE = path.join('.teeny', 'temporary.json')

/**
 * What teeny remembers about the project's temporary deployment. Mode 0600: the claim URL is a
 * bearer credential (anyone with it can take the account). Never logged or sent anywhere.
 */
export interface TemporaryDeploymentState {
    accountId?: string
    accountName: string
    claimUrl: string
    expiresAt: string
    url?: string
    updatedAt: string
}

export function readTemporaryState(root: string): TemporaryDeploymentState | undefined {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(root, TEMPORARY_STATE_FILE), 'utf8'))
        if (data && typeof data.accountName === 'string' && typeof data.claimUrl === 'string' && typeof data.expiresAt === 'string') return data
    } catch { /* missing or unreadable: no previous temporary deployment */ }
    return undefined
}

export function writeTemporaryState(root: string, state: TemporaryDeploymentState): void {
    const file = path.join(root, TEMPORARY_STATE_FILE)
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', {mode: 0o600})
    fs.chmodSync(file, 0o600) // writeFileSync's mode only applies when the file is created
}

// ── config checks ──

/** Binding/config keys for products Cloudflare doesn't list as supported on temporary accounts. */
const UNSUPPORTED_KEYS: Record<string, string> = {
    r2_buckets: 'R2 buckets',
    vectorize: 'Vectorize indexes',
    ai: 'Workers AI',
    browser: 'Browser Rendering',
    images: 'Images',
    analytics_engine_datasets: 'Analytics Engine datasets',
    send_email: 'Email sending',
    dispatch_namespaces: 'Workers for Platforms dispatch namespaces',
    workflows: 'Workflows',
    pipelines: 'Pipelines',
    secrets_store_secrets: 'Secrets Store secrets',
    containers: 'Containers',
}

function present(value: any): boolean {
    if (Array.isArray(value)) return value.length > 0
    return value !== undefined && value !== null && value !== false && value !== ''
}

/**
 * What in a wrangler config can't be deployed to a temporary account, checked before any API call.
 * Supported (per Cloudflare's docs): Workers on workers.dev, static assets, KV, one D1 database
 * (100 MB), Durable Objects, Hyperdrive, Queues, mTLS/CA certificates. R2 is verified unsupported
 * (the API refuses it with code 10000); the rest of {@link UNSUPPORTED_KEYS} is simply not on
 * Cloudflare's list.
 */
export function findTemporaryAccountConfigProblems(config: any): string[] {
    const problems: string[] = []
    const scopes: [string, any][] = [['', config]]
    for (const [envName, envConfig] of Object.entries(config?.env ?? {})) scopes.push([`env.${envName}.`, envConfig])
    const d1Names = new Set<string>()
    for (const [prefix, scope] of scopes) {
        if (!scope || typeof scope !== 'object') continue
        for (const [key, label] of Object.entries(UNSUPPORTED_KEYS)) {
            if (present(scope[key])) problems.push(`${prefix}${key}: ${label} aren't available on temporary accounts`)
        }
        if (present(scope.routes) || present(scope.route)) {
            problems.push(`${prefix}${present(scope.routes) ? 'routes' : 'route'}: temporary accounts only serve on workers.dev (no custom domains or routes)`)
        }
        for (const d of scope.d1_databases ?? []) d1Names.add(String(d?.database_name ?? d?.database_id ?? d?.binding))
    }
    if (d1Names.size > 1) problems.push(`d1_databases: ${d1Names.size} databases configured, temporary accounts allow one`)
    return problems
}

/** Which env variable holds Cloudflare credentials (wrangler then refuses `--temporary`). */
export function findEnvCredential(env: NodeJS.ProcessEnv = process.env): string | undefined {
    for (const key of ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN']) if (env[key]) return key
    const apiKey = ['CLOUDFLARE_API_KEY', 'CF_API_KEY'].find(k => env[k])
    const email = ['CLOUDFLARE_EMAIL', 'CF_EMAIL'].find(k => env[k])
    if (apiKey && email) return apiKey
    return undefined
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The `[...]` JSON array in `wrangler d1 list --json` stdout. */
export function parseD1List(stdout: string): {uuid: string, name: string}[] {
    const start = stdout.indexOf('[')
    const end = stdout.lastIndexOf(']')
    if (start < 0 || end < start) throw new Error(`Unexpected output from "wrangler d1 list --json": ${stdout.slice(0, 300)}`)
    const list = JSON.parse(stdout.slice(start, end + 1))
    if (!Array.isArray(list)) throw new Error('Unexpected output from "wrangler d1 list --json": not a list')
    return list.filter(d => d && typeof d.uuid === 'string').map(d => ({uuid: d.uuid, name: String(d.name ?? '')}))
}

function minutesLeft(expiresAt: string, now = Date.now()): number {
    return Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 60_000))
}

function formatExpiry(expiresAt: string): string {
    const d = new Date(expiresAt)
    return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC (in ${minutesLeft(expiresAt)} minutes)`
}

/**
 * Everything `--temporary` needs before the command touches config or data. Runs before any other
 * Cloudflare call:
 * 1. checks (no API call): wrangler ≥ 4.102, no env credentials, no foreign account_id, no
 *    unsupported bindings;
 * 2. Cloudflare's terms: printed, and confirmed interactively unless `--yes`, when a new account will be created;
 * 3. `wrangler d1 list --json --temporary` creates or reuses the account and lists its databases;
 * 4. config: a database_id the account doesn't have (the previous temporary account expired, or
 *    another machine/user made a new one) is reset to TEENY_AUTO_CREATE together with the saved
 *    apiRoute; an existing database with the configured name is adopted (only one D1 database is
 *    allowed, so a half-failed earlier create must not block the next run); account_id is set to the
 *    temporary account so that after claiming it, `wrangler login` + `teeny deploy --remote` need no edits;
 * 5. `.teeny/temporary.json` records the account, claim URL and expiry.
 */
export async function prepareTemporaryAccount(c: CliContext): Promise<TemporaryAccountInfo> {
    const yes = !!(c.options.yes || c.options.y)
    const configPath = c.wranglerConfig.config.path
    const configFile = readableRelative(configPath)

    const {version} = resolveWranglerPackage(c.root)
    if (!versionAtLeast(version, WRANGLER_MIN_TEMPORARY)) {
        throw new Error(`--temporary needs wrangler ${WRANGLER_MIN_TEMPORARY} or newer, and this project has wrangler ${version || '(unknown version)'}. Run "npm install --save-dev wrangler@latest" and try again.`)
    }
    const envCredential = findEnvCredential()
    if (envCredential) {
        throw new Error(`--temporary is for deploying without a Cloudflare login, but ${envCredential} is set. Deploy to that account with "npx teenybase deploy --remote", or unset ${envCredential} to use a temporary account.`)
    }

    const config = c.wranglerConfig.config.config
    const configAccountId = typeof config.account_id === 'string' ? config.account_id.trim() : ''
    const problems = findTemporaryAccountConfigProblems(config)
    if (problems.length) {
        throw new Error(`This project can't be deployed to a temporary Cloudflare account:\n  - ${problems.join('\n  - ')}\nRemove these from ${configFile}, or log in ("npx wrangler login") and deploy to your own account with "npx teenybase deploy --remote".`)
    }

    const previous = readTemporaryState(c.root)
    const cachedBefore = readWranglerTemporaryAccount()
    if (configAccountId && configAccountId !== previous?.accountId && configAccountId !== cachedBefore?.id) {
        throw new Error(`${configFile} has account_id "${configAccountId}", which isn't a temporary account teeny deployed to. --temporary deploys to a new temporary account and would replace account_id and database_id. Remove account_id from ${configFile} to use --temporary, or deploy to that account with "npx teenybase deploy --remote".`)
    }

    if (!isCachedAccountActive(cachedBefore)) {
        c.logger.info(TEMPORARY_TERMS_NOTICE)
        if (!yes) {
            const ok = await ask<boolean>({
                type: 'confirm',
                message: 'Create a temporary Cloudflare account and continue?',
                initial: true,
            }, 'Pass --yes to accept Cloudflare\'s terms and continue.')
            if (!ok) throw new Error('Cancelled: Cloudflare\'s terms were not accepted.')
        }
    }

    const listed = await withMinimalWranglerConfig(config, configFile =>
        c.runWrangler(['d1', 'list', '--json', `--config=${configFile}`], {echo: false}))
    const databases = parseD1List(listed.stdout)
    const notice = parseTemporaryAccountNotice(listed.stderr) ?? parseTemporaryAccountNotice(listed.output)
    const cached = readWranglerTemporaryAccount()
    const fromCache = cached && (!notice || cached.name === notice.name) ? cached : undefined
    if (!fromCache && !notice) {
        throw new Error('wrangler didn\'t report which temporary account it used. Run with --debug and report this.')
    }
    let expiresAt: string
    if (fromCache) {
        expiresAt = Date.parse(fromCache.claimExpiresAt) < Date.parse(fromCache.expiresAt) ? fromCache.claimExpiresAt : fromCache.expiresAt
    } else {
        const ms = parseClaimWithin(notice!.claimWithin)
        expiresAt = new Date(Date.now() + (ms ?? 0)).toISOString()
    }
    const account: TemporaryAccountInfo = {
        id: fromCache?.id,
        name: fromCache?.name ?? notice!.name,
        claimUrl: fromCache?.claimUrl ?? notice!.claimUrl,
        expiresAt,
        // A retried call (code 10000) reports the account it just created as "reused", so also compare
        // with the cache before the call.
        created: !!notice?.created || (!!fromCache && !isCachedAccountActive(cachedBefore)),
    }

    const accountChanged = !!previous && (previous.accountId && account.id ? previous.accountId !== account.id : previous.accountName !== account.name)

    // Database: keep, adopt by name, or reset to TEENY_AUTO_CREATE.
    let content = fs.readFileSync(configPath, 'utf8')
    const isToml = configPath.endsWith('.toml')
    const db = c.wranglerConfig.db
    let databaseId = String(db.database_id ?? '')
    let databaseReset = false
    let adopted: {uuid: string, name: string} | undefined
    const missingDatabaseId = databaseId
    if (UUID_RE.test(databaseId) && !databases.some(d => d.uuid === databaseId)) {
        content = replacePlaceholderInConfig(content, 'database_id', databaseId, AUTO_CREATE, isToml)
        databaseId = AUTO_CREATE
        databaseReset = true
    }
    if (databaseId.startsWith(AUTO_CREATE)) {
        const name = parsePlaceholder(databaseId).name || db.database_name
        const existing = databases.find(d => d.name === name)
        if (existing) {
            content = replacePlaceholderInConfig(content, 'database_id', databaseId, existing.uuid, isToml)
            adopted = existing
        } else if (databases.length) {
            throw new Error(`Temporary accounts allow one D1 database, and this one already has ${databases.map(d => `'${d.name}'`).join(', ')} (probably another project deployed with --temporary from this computer in the last hour). Claim that account and deploy there with "npx teenybase deploy --remote", wait until it expires, or set database_name to '${databases[0].name}' in ${configFile} to share it.`)
        }
    }
    if (content !== fs.readFileSync(configPath, 'utf8')) {
        fs.writeFileSync(configPath, content)
        c.databaseIdChanged = true
    }

    if (accountChanged) {
        c.logger.warn(`Your previous temporary deployment (account "${previous!.accountName}") has expired or was claimed. Deploying to a new temporary account: new URL, empty database.`)
    } else if (databaseReset) {
        c.logger.warn(`The database ${missingDatabaseId} in ${configFile} doesn't exist in the temporary account "${account.name}"; ${adopted ? `using its database '${adopted.name}' instead` : 'a new empty one will be created'}.`)
    }
    if (adopted && !databaseReset) c.logger.info(`Using the existing D1 database '${adopted.name}' in the temporary account.`)
    // Only a new account invalidates the URL; after a database-only reset the worker is still there.
    if (accountChanged && await c.getApiRoute(true)) {
        removeProjectConfigKey(c.root, apiRouteKey)
        c.clearApiRoute()
        c.logger.debug(`Removed ${apiRouteKey} from ${projectConfigFile} (it pointed at the old deployment)`)
    }
    if (account.id && configAccountId !== account.id) {
        writeAccountIdToWranglerConfig(configPath, account.id)
        c.logger.info(`Set account_id = "${account.id}" (the temporary account) in ${configFile}.`)
    } else if (!account.id) {
        c.logger.warn(`Couldn't read the temporary account's id from wrangler's cache, so account_id isn't set in ${configFile}. After claiming the account, "npx wrangler login" + "npx teenybase deploy --remote" finds it from your login.`)
    }

    writeTemporaryState(c.root, {
        accountId: account.id,
        accountName: account.name,
        claimUrl: account.claimUrl,
        expiresAt: account.expiresAt,
        url: accountChanged ? undefined : previous?.url,
        updatedAt: new Date().toISOString(),
    })

    c.logger.info(`Temporary Cloudflare account: ${colors.bold(account.name)} (${account.created ? 'created' : 'reused'}), ${minutesLeft(account.expiresAt)} minutes left to claim it. The claim link is printed at the end and saved in ${TEMPORARY_STATE_FILE}.`)

    c.wranglerConfig = await parseWrangler(c.options.root, c.options, c.logger)
    c.temporaryAccount = account
    return account
}

/**
 * The block printed at the end of `teeny deploy --temporary`: live URL, claim URL, expiry and what
 * claiming means. teeny hides wrangler's own copy of this (printed on every call).
 */
export async function printTemporaryDeployment(c: CliContext): Promise<void> {
    const account = c.temporaryAccount
    if (!account) return
    const url = await c.getApiRoute(true)
    const previous = readTemporaryState(c.root)
    if (previous) writeTemporaryState(c.root, {...previous, url: url ?? previous.url, updatedAt: new Date().toISOString()})

    const lines = [
        '',
        colors.bold(`Temporary deployment on Cloudflare account "${account.name}"`),
        `  Live URL:   ${url ?? '(not deployed yet)'}`,
        `  Claim URL:  ${account.claimUrl}`,
        `  Expires:    ${formatExpiry(account.expiresAt)}`,
        '',
        '  To keep it, open the claim URL and sign in to Cloudflare or create a free account, then finish the',
        '  prompts before it expires. Opening the link is not enough. The account then becomes yours with the',
        '  Worker, its URL and the database. After that, deploy with:',
        `    ${colors.cyan('npx wrangler login')}`,
        `    ${colors.cyan('npx teenybase deploy --remote')}`,
        '',
        '  The claim URL works like a password: anyone who has it can take the account. Don\'t share it.',
        '  If nobody claims it, Cloudflare deletes the account, the Worker and the database with all its data.',
        `  Redeploying with --temporary before then keeps the same URL and database. (Saved in ${TEMPORARY_STATE_FILE})`,
    ]
    for (const line of lines) c.logger.info(line)
}
