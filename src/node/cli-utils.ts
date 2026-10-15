import colors from 'picocolors'
import {ask} from './prompts'
import path from 'path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {createLogger, Logger, LogLevel} from './logger'
import {unstable_dev, Unstable_DevOptions, Unstable_DevWorker} from 'wrangler'
import {escapeRegExp, normalizePath, readableRelative, getErrorMessage} from './utils'
import {loadConfigFromFile, loadWranglerConfigFromFile} from './config'
import {DatabaseSettings} from '../types/config'
import dotenv from 'dotenv'
import {parse as jsoncParse, modify as jsoncModify, applyEdits as jsoncApplyEdits} from 'jsonc-parser'
import {URL} from 'url'
import {generateMigrations, nextUserIndex} from '../sql/schema/generateMigrations'
import {jsonStringify} from '../utils/string'
import {databaseSettingsSchema} from '../types/zod/databaseSettingsSchema'
import {assertTablesHaveAccessPolicy} from '../types/config/tableAccessPolicy'
import {RequestInfo} from '@cloudflare/workers-types'
import {DBMigration, MigrationHelperRaw} from '../worker/migrationHelper'
import {$DatabaseNode} from './$DatabaseNode'
// import {executeSql} from './wrangler/d1/execute'
import {parseJSONC} from './workers-utils'
import {D1Error} from '../worker'
import {makeD1Binding} from './utils/make-d1-binding'
import {resolveWranglerPackage} from './utils/wrangler-bin'
import {
    runWrangler,
    RunWranglerOptions,
    versionAtLeast,
    withMinimalWranglerConfig,
    WRANGLER_MIN_SECRETS_FILE,
    WranglerCommandError,
    WranglerResult,
    wranglerCommand,
} from './utils/wrangler-run'
import type {TemporaryAccountInfo} from './temporary-account'
import {resolveDeployAccountId} from './cloudflare-account'

export const adminTokenKey = 'ADMIN_SERVICE_TOKEN'
export const apiRouteKey = 'apiRoute'
export const devVars = '.dev.vars'
export const prodVars = '.prod.vars'
export const projectConfigFile = 'infra.jsonc'
/** Snapshot suffix used by `teeny dev` (see CliContext.createCustomTsconfigForWorker). */
export const DEV_SERVER_SNAPSHOT = 'dev'
/** Snapshot suffix of the internal local worker started by deploy/exec --local when no dev server answers. */
const LOCAL_WORKER_SNAPSHOT = 'local-worker'

/** Join a base URL and path without mangling the protocol double-slash. */
function joinUrl(base: string, urlPath: string): string {
    return base.replace(/\/+$/, '') + '/' + urlPath.replace(/^\/+/, '')
}

// todo handle projects using vite with wrangler and maybe make that the primary workflow

// global options
export interface GlobalCLIOptions {
    '--'?: string[]
    c?: boolean | string
    root?: string
    config?: string
    wrangler?: string
    db?: string
    // base?: string
    l?: LogLevel
    logLevel?: LogLevel
    remote?: boolean
    local?: boolean
    /** Deploy to a Cloudflare temporary account (wrangler --temporary). Implies remote. */
    temporary?: boolean
    clearScreen?: boolean
    d?: boolean | string
    debug?: boolean | string
    f?: string
    filter?: string
    y?: boolean
    yes?: boolean
    // m?: string
    // mode?: string
    // force?: boolean
    // w?: boolean
}

export type TargetMode = 'both' | 'local' | 'remote' | 'none'

export const deduplicateOptions = <T extends object>(options: T) => {
    for (const [key, value] of Object.entries(options)) {
        if (Array.isArray(value)) {
            options[key as keyof T] = value[value.length - 1]
        }
    }
}

export const applyTargetMode = (options: GlobalCLIOptions, mode: TargetMode, supportsTemporary = false) => {
    if (options.temporary) {
        if (!supportsTemporary) throw new Error('This command doesn\'t support --temporary.')
        if (options.local) throw new Error('--temporary deploys to Cloudflare; it can\'t be combined with --local.')
        // --temporary is a remote target on a temporary account
        options.remote = true
    }
    if (mode === 'none') {
        if (options.local || options.remote) {
            throw new Error('This command does not use --local or --remote. Run without target flags.')
        }
        return
    }
    if (mode === 'local') {
        if (options.remote) throw new Error('This command only works locally. Remove --remote to continue.')
        options.local = true
        return
    }
    if (mode === 'remote') {
        if (options.local) throw new Error('This command only works remotely. Remove --local to continue.')
        options.remote = true
        return
    }
    // mode === 'both'
    if (!options.local && !options.remote) {
        throw new Error('Specify a target: use --local for development or --remote for production.')
    }
    if (options.local && options.remote) {
        throw new Error('Use --local for development or --remote for production, not both.')
    }
}

// const ctx = {c: undefined} as {c: CliContext|undefined}
// function setContext(c: CliContext){
//     return ctx.c = c
// }
// function getContext(){
//     if(!ctx.c) throw new Error('Context not created')
//     return ctx.c
// }
const localPersist = '.local-persist'

/**
 * Write account_id into a wrangler config file (JSONC or TOML).
 * Inserts after the "name" field if account_id doesn't exist yet.
 */
export function writeAccountIdToWranglerConfig(configPath: string, accountId: string): void {
    let content = fs.readFileSync(configPath, 'utf8')
    const isToml = configPath.endsWith('.toml')

    if (isToml) {
        // Check if account_id already exists
        if (/^\s*account_id\s*=/m.test(content)) {
            // Replace existing value
            content = content.replace(/^(\s*account_id\s*=\s*)(["']).*?\2/m, `$1"${accountId}"`)
        } else {
            // Insert after name = "..."
            content = content.replace(/(name\s*=\s*["'].*?["'])/m, `$1\naccount_id = "${accountId}"`)
        }
    } else {
        // JSONC
        if (/"account_id"\s*:/.test(content)) {
            // Replace existing value
            content = content.replace(/("account_id"\s*:\s*)(["']).*?\2/, `$1"${accountId}"`)
        } else {
            // Insert after "name": "..."
            content = content.replace(/("name"\s*:\s*"[^"]*")/, `$1,\n    "account_id": "${accountId}"`)
        }
    }

    fs.writeFileSync(configPath, content)
}

// --- Auto-create resources from TEENY_AUTO_CREATE placeholders ---

export const AUTO_CREATE = 'TEENY_AUTO_CREATE'
const MAX_CREATE_RETRIES = 3
const MAX_PLACEHOLDER_ITERATIONS = 20
const VALID_REGIONS = ['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc']
const UUID_OUTPUT_RE = /"?database_id"?\s*[=:]\s*"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"?/

/**
 * Parse TEENY_AUTO_CREATE[:region[:name]] placeholder.
 * Examples:
 *   TEENY_AUTO_CREATE            → {}
 *   TEENY_AUTO_CREATE:weur       → { region: 'weur' }
 *   TEENY_AUTO_CREATE:weur:name  → { region: 'weur', name: 'name' }
 *   TEENY_AUTO_CREATE::name      → { name: 'name' }
 */
export function parsePlaceholder(value: string): { region?: string, name?: string } {
    const rest = value.slice(AUTO_CREATE.length)
    if (!rest) return {}
    // rest = ":region:name" or "::name" or ":region"
    const parts = rest.slice(1).split(':') // remove leading ":"
    const first = parts[0] || undefined
    const isRegion = first && VALID_REGIONS.includes(first)
    const region = isRegion ? first : undefined
    // If first part is not a valid region, it's part of the name (not silently dropped)
    const nameParts = isRegion ? parts.slice(1) : (first ? parts : parts.slice(1))
    const name = nameParts.filter(Boolean).join(':') || undefined
    return { region, name }
}

/**
 * Replace the placeholder value in a wrangler config file.
 * Handles both JSONC ("key": "value") and TOML (key = "value" or key = 'value') formats.
 */
export function replacePlaceholderInConfig(content: string, key: string, placeholder: string, replacement: string, isToml: boolean): string {
    // Try double-quoted pattern first (JSONC and TOML)
    const dqPattern = isToml
        ? new RegExp(`(${key}\\s*=\\s*")${escapeRegExp(placeholder)}(")`)
        : new RegExp(`("${key}"\\s*:\\s*")${escapeRegExp(placeholder)}(")`)
    const dqResult = content.replace(dqPattern, `$1${replacement}$2`)
    if (dqResult !== content) return dqResult

    // Try single-quoted TOML pattern
    if (isToml) {
        const sqPattern = new RegExp(`(${key}\\s*=\\s*')${escapeRegExp(placeholder)}(')`)
        const sqResult = content.replace(sqPattern, `$1${replacement}$2`)
        if (sqResult !== content) return sqResult
    }

    throw new Error(`Could not find ${key} = "${placeholder}" in wrangler config to replace. Check the file format.`)
}

/**
 * Scan wrangler config for TEENY_AUTO_CREATE placeholders and create resources.
 * For each placeholder: determine type (D1/R2), resolve name/region, run wrangler create,
 * replace placeholder with the resource ID, re-parse config, repeat.
 */
export async function autoCreateResources(c: CliContext, skipConfirmation: boolean): Promise<void> {
    const isToml = c.wranglerConfig.config.path.endsWith('.toml')

    for (let iteration = 0; iteration < MAX_PLACEHOLDER_ITERATIONS; iteration++) {
        const configPath = c.wranglerConfig.config.path
        let content = fs.readFileSync(configPath, 'utf8')
        if (!content.includes(AUTO_CREATE)) return

        const config = c.wranglerConfig.config.config

        // Collect all d1_databases and r2_buckets arrays from top-level AND env.* blocks
        const allD1: any[] = [...(config.d1_databases || [])]
        const allR2: any[] = [...(config.r2_buckets || [])]
        if (config.env) {
            for (const envConfig of Object.values(config.env) as any[]) {
                if (envConfig?.d1_databases) allD1.push(...envConfig.d1_databases)
                if (envConfig?.r2_buckets) allR2.push(...envConfig.r2_buckets)
            }
        }

        const d1Match = allD1.find(
            (d: any) => typeof d.database_id === 'string' && d.database_id.startsWith(AUTO_CREATE)
        )
        const r2Match = allR2.find(
            (r: any) => typeof r.bucket_name === 'string' && r.bucket_name.startsWith(AUTO_CREATE)
        )

        if (d1Match) {
            const placeholder = d1Match.database_id as string
            const parsed = parsePlaceholder(placeholder)
            const replacement = await createResource(c, {
                type: 'd1',
                name: parsed.name || d1Match.database_name,
                region: parsed.region,
                skipConfirmation,
            })
            content = replacePlaceholderInConfig(content, 'database_id', placeholder, replacement, isToml)
            fs.writeFileSync(configPath, content)
        } else if (r2Match) {
            const placeholder = r2Match.bucket_name as string
            const parsed = parsePlaceholder(placeholder)
            const replacement = await createResource(c, {
                type: 'r2',
                name: parsed.name,
                region: parsed.region,
                skipConfirmation,
            })
            content = replacePlaceholderInConfig(content, 'bucket_name', placeholder, replacement, isToml)
            fs.writeFileSync(configPath, content)
        } else {
            // AUTO_CREATE in raw file but not in any d1/r2 field (top-level or env) — likely in a comment
            return
        }

        // Re-parse wrangler config so CliContext has fresh values
        c.wranglerConfig = await parseWrangler(c.options.root, c.options, c.logger)
    }
    // If we exhausted iterations, check if there are still unresolved placeholders
    const remaining = fs.readFileSync(c.wranglerConfig.config.path, 'utf8')
    if (remaining.includes(AUTO_CREATE)) {
        throw new Error(`Too many ${AUTO_CREATE} placeholders in wrangler config (max ${MAX_PLACEHOLDER_ITERATIONS}). Resolve some manually.`)
    }
}

interface CreateResourceOpts {
    type: 'd1' | 'r2'
    name?: string
    region?: string
    skipConfirmation: boolean
}

async function createResource(c: CliContext, opts: CreateResourceOpts): Promise<string> {
    const { type, skipConfirmation } = opts
    const typeLabel = type === 'd1' ? 'D1 database' : 'R2 bucket'
    const createArgs = type === 'd1' ? ['d1', 'create'] : ['r2', 'bucket', 'create']

    // Resolve name
    let name = opts.name
    if (!name) {
        if (skipConfirmation) {
            if (type === 'r2') {
                name = `teenybase-${crypto.randomBytes(6).toString('hex')}`
            } else {
                throw new Error(`${typeLabel} name is required. Set database_name in wrangler config or use TEENY_AUTO_CREATE:region:name format.`)
            }
        } else {
            const value = await ask<string>({
                type: 'text',
                message: `Enter name for the new ${typeLabel}:`,
                validate: (v: string) => v.length >= 1 || 'Name is required',
            }, `Set the ${type === 'd1' ? 'database_name' : 'bucket_name'} in your wrangler config.`)
            if (!value) throw new Error('Resource creation cancelled')
            name = value
        }
    }

    // Resolve region
    let region = opts.region
    if (!region && !skipConfirmation) {
        const value = await ask<string>({
            type: 'select',
            message: `Select region for ${typeLabel} '${name}':`,
            choices: [
                { title: 'Auto (Cloudflare chooses)', value: '' },
                { title: 'Western Europe (weur)', value: 'weur' },
                { title: 'Eastern Europe (eeur)', value: 'eeur' },
                { title: 'Western North America (wnam)', value: 'wnam' },
                { title: 'Eastern North America (enam)', value: 'enam' },
                { title: 'Asia Pacific (apac)', value: 'apac' },
                { title: 'Oceania (oc)', value: 'oc' },
            ],
        }, 'Pass --yes to let Cloudflare choose the region.')
        region = value || undefined
    }

    const realConfig = c.wranglerConfig.config.config

    // Create with retries
    for (let attempt = 0; attempt < MAX_CREATE_RETRIES; attempt++) {
        if (!skipConfirmation && attempt === 0) {
            const ok = await ask<boolean>({
                type: 'confirm',
                message: `Create ${typeLabel} '${name}'?`,
                initial: true,
            }, 'Pass --yes to create it.')
            if (!ok) throw new Error('Resource creation cancelled')
        } else if (attempt === 0) {
            c.logger.info(`Creating ${typeLabel} '${name}'...`)
        }

        try {
            // A minimal config (name + account_id): the real one may still hold TEENY_AUTO_CREATE
            // placeholders that fail wrangler's validation.
            const {stdout} = await withMinimalWranglerConfig(realConfig, configPath => c.runWrangler(
                [...createArgs, name!, ...(region ? ['--location', region] : []), `--config=${configPath}`],
            ))
            if (type === 'd1') {
                const match = stdout.match(UUID_OUTPUT_RE)
                if (!match) throw new Error('Could not parse database_id from wrangler d1 create output')
                return match[1]
            }
            return name!
        } catch (e: any) {
            const err = e instanceof WranglerCommandError ? `${e.message}\n${e.output}` : getErrorMessage(e)

            // Name already taken on CF
            if (err.includes('already exists') || err.includes('already been used')) {
                if (skipConfirmation) {
                    throw new Error(`${typeLabel} '${name}' already exists. Change the name in your wrangler config and retry.`)
                }
                c.logger.error(`${typeLabel} '${name}' already exists.`)
                const newName = await ask<string>({
                    type: 'text',
                    message: `Enter a different name for the ${typeLabel}:`,
                    validate: (v: string) => v.length >= 1 || 'Name is required',
                }, 'Change the name in your wrangler config.')
                if (!newName) throw new Error('Resource creation cancelled')
                name = newName
                continue
            }

            // Resource limit
            if (err.includes('Resource limit') || err.includes('maximum number of D1 databases')) {
                throw new Error(c.isTemporary && type === 'd1'
                    ? `Cannot create ${typeLabel} '${name}': temporary accounts allow one D1 database and this one already has one. Claim that account, or wait until it expires, and try again.`
                    : `Cannot create ${typeLabel}: ${e instanceof WranglerCommandError ? e.message : err}`)
            }

            throw e
        }
    }
    throw new Error(`Failed to create ${typeLabel} after ${MAX_CREATE_RETRIES} attempts`)
}

export class CliContext{
    localWorker: Unstable_DevWorker|undefined
    readonly migrationsPath: string
    get isLocal(){
        return !this.options.remote
    }
    readonly root: string
    readonly logger: Logger
    readonly devServerLogLevel: Unstable_DevOptions['logLevel']
    devServerPort: number

    constructor(root: string|undefined, public options: GlobalCLIOptions, public wranglerConfig: WranglerConfigRet, logger: Logger, devServerLogLevel: Unstable_DevOptions['logLevel'] = "none") {
        this.logger = logger
        this.root = normalizePath(root ? path.resolve(root) : process.cwd())
        this.migrationsPath = path.join(this.root, wranglerConfig.migrations)
        this.devServerLogLevel = devServerLogLevel
        this.devServerPort = parseInt(process.env.TEENY_DEV_PORT || wranglerConfig.config.config.dev?.port || '8787')
        if(isNaN(this.devServerPort) || this.devServerPort <= 0 || this.devServerPort >= 65536){
            throw new Error(`Invalid port number specified in TEENY_DEV_PORT environment variable: ${process.env.TEENY_DEV_PORT}`)
        }
    }

    get localPersistPath(){
        return path.join(this.root, localPersist)
    }

    /** Set by `--temporary` once the temporary account is known (see prepareTemporaryAccount). */
    temporaryAccount: TemporaryAccountInfo | undefined
    /** The database_id in the wrangler config was replaced in this run before deploying (prepareTemporaryAccount). */
    databaseIdChanged = false

    /** Deploying to a Cloudflare temporary account (`--temporary`). */
    get isTemporary(): boolean {
        return !!this.options.temporary
    }

    /**
     * Run wrangler in the project root. Every wrangler call that can reach Cloudflare goes through
     * here (or {@link wranglerCommand}), so `--temporary` is added wherever wrangler supports it.
     */
    runWrangler(args: string[], opts?: Partial<Omit<RunWranglerOptions, 'root' | 'args' | 'logger' | 'temporary'>>): Promise<WranglerResult> {
        return runWrangler({root: this.root, args, logger: this.logger, temporary: this.isTemporary, ...opts})
    }

    /** `[command, argv]` for spawning wrangler yourself (sync callers); same `--temporary` handling as {@link runWrangler}. */
    wranglerCommand(args: string[]): [string, string[]] {
        return wranglerCommand(this.root, args, this.isTemporary)
    }

    /** Returns `--config=<path>` flag for wrangler subcommands, ensuring the correct config file is used. */
    get wranglerConfigFlag(): string {
        return `--config=${this.wranglerConfig.config.path}`
    }

    buildLocal(config: DatabaseSettings, outDir?: string, log = true, doThrow = true, clean = false, flags: string[] = []): boolean{
        const _outDir = outDir ?
            // explicit path is always resolved from cwd
            path.resolve(outDir) :
            path.join(this.root, '.teeny', 'tmp', 'dist-worker')
        const lastWLogEnv = process.env.WRANGLER_LOG
        process.env.WRANGLER_LOG = log ? 'info' : 'error'
        try {
            const [cmd, argv] = this.wranglerCommand(['deploy', this.wranglerConfigFlag, '--dry-run', ...flags, `--outdir=${_outDir}`, `--tsconfig=${this.createCustomTsconfigForWorker(config, 'bl')}`])
            // todo switch to spawn so cleanup (removeCustomTsconfig) runs even if process is killed
            execFileSync(cmd, argv, {cwd: this.root, stdio: ['inherit', 'pipe', 'pipe']})
            return true
        }catch (e: any) {
            const err = ''+ e.stderr
            const isBuildError = err.match(/Build failed with (\d+) errors:/g)
            const migrationsDir = readableRelative(this.migrationsPath)
            const legacyConfigFile = path.join(migrationsDir, 'config.json') // = ./migrations/config.json
            if(isBuildError?.length){
                // Old pattern: import config from './migrations/config.json'
                const legacyConfigNotFound = !!err.match(new RegExp(`Could not resolve "${escapeRegExp(readableRelative(legacyConfigFile))}"`, 'gm'))?.length
                if(legacyConfigNotFound){
                    this.logger.error(`✘ [ERROR] Unable to build the worker - importing from migrations/config.json is no longer supported. Use \`import config from 'virtual:teenybase'\` instead. Run \`teeny init\` to set up the path alias automatically.`)
                }
                // New pattern: import config from 'virtual:teenybase'
                const virtualNotFound = !!err.match(/Could not resolve "virtual:teenybase"/gm)?.length
                if(virtualNotFound){
                    this.logger.error(`✘ [ERROR] Unable to resolve virtual:teenybase. Ensure your tsconfig.json has a "virtual:teenybase" path alias pointing to your config file (e.g., \`"paths": { "virtual:teenybase": ["./teenybase"] }\`). Run \`teeny init\` to set this up automatically.`)
                }
                //   ✘ [ERROR] Unexpected "a" in JSON
                //
                //       migrations/config.json:176:10:
                const isConfigError = !!err.match(new RegExp(`${escapeRegExp(legacyConfigFile)}:\\d+:\\d+:`, 'g'))?.length
                if(isConfigError){
                    this.logger.error(`✘ [ERROR] Unable to build the worker - config file is not valid JSON. Run \`teeny deploy --local\` to regenerate the config.`)
                }
                if(!log) {
                    const errorCount = isBuildError ? parseInt(isBuildError[1]) : 0
                    this.logger.error(`✘ [ERROR] Unable to build the worker - ${errorCount} error(s). Run teeny build to see the errors`)
                }
            }
            if(log){
                this.logger.info(''+e.stdout)
                if(!doThrow) this.logger.error(''+e.stderr)
            }
            if(doThrow) throw e
            return false
        }finally {
            process.env.WRANGLER_LOG = lastWLogEnv
            // cleanup
            if(clean) fs.rmSync(_outDir, {recursive: true})
            this.removeCustomTsconfig('bl')
        }
    }

    /**
     * Settings for the internal local worker when they differ from .local-persist/config.json.
     * `deploy --local` sets this to the not-yet-applied config, which is only persisted after the
     * migrations succeed. Only read when the worker starts.
     */
    localWorkerSettings: DatabaseSettings | undefined
    private _startingPromise: Promise<Unstable_DevWorker>|undefined
    async startLocal(){
        if(this.localWorker) return this.localWorker
        if(this._startingPromise) return await this._startingPromise
        const localConfig = this.localWorkerSettings ?? loadLocalPersistConfig(this)
        if(!localConfig){
            throw new Error(`No local config found in ${readableRelative(path.join(this.localPersistPath, 'config.json'))}. Starting local worker without persistence. Run "teeny deploy --local" to generate the local config.`)
        }
        const built = this.buildLocal(localConfig, undefined, false, false, true)
        if(!built){
            throw new Error('Unable to build and connect to local worker. Run "teeny dev --local" to check the errors.')
        }

        if(this.options.local) this.logger.info('Setting up local database...')
        const entrypoint = path.resolve(this.root, this.wranglerConfig.config.config.main)
        this._startingPromise = this.options.local ? unstable_dev(entrypoint, {
            config: this.wranglerConfig.config.path,
            port: this.devServerPort,
            local: true,
            bundle: true,
            persistTo: this.localPersistPath,
            logLevel: this.devServerLogLevel,
            experimental: {
                disableExperimentalWarning: true,
            },
            // @ts-expect-error types are wrong
            tsconfig: this.createCustomTsconfigForWorker(localConfig, LOCAL_WORKER_SNAPSHOT),
        }) : undefined
        this.localWorker = await this._startingPromise
        if(this.localWorker) this.logger.debug('Local worker started')
        return this.localWorker
    }
    async localFetch(input?: RequestInfo, init?: RequestInit): Promise<Response>{
        const w = await this.startLocal()
        if(!w) throw new Error('Unable to start local worker')
        this.logger.debug(`Fetching ${input}`)
        // @ts-expect-error check in next version, type mismatch between undici and cloudflare workers, but should be compatible
        return await w.fetch(input, init as any) as any
    }
    private _stopping = false
    async stopLocal(){
        if(!this.localWorker || this._stopping) return
        this._stopping = true
        await this.localWorker.stop()
        this.logger.debug('Local worker stopped')
        this.localWorker = undefined
        this._stopping = false
        this.removeCustomTsconfig(LOCAL_WORKER_SNAPSHOT)
    }

    /**
     * Write the settings snapshot that `virtual:teenybase` resolves to for the worker built with
     * the matching {@link createCustomTsconfigForWorker} suffix. Rewriting it while `wrangler dev`
     * runs makes wrangler rebuild and reload the worker with the new settings.
     */
    writeWorkerConfigSnapshot(config: DatabaseSettings, suffix: string): string {
        const tempConfigDir = path.join(this.root, '.teeny')
        const tempConfigPath = path.join(tempConfigDir, `.tmp.config.${suffix}.json`)
        if (!fs.existsSync(tempConfigDir)) fs.mkdirSync(tempConfigDir, {recursive: true})
        writeFileAtomic(tempConfigPath, JSON.stringify(config, null, 2))
        return tempConfigPath
    }

    createCustomTsconfigForWorker(config: DatabaseSettings, suffix = 'worker'){
        const tempConfigPath = path.join(this.root, '.teeny', `.tmp.config.${suffix}.json`)

        const tsconfigPath = path.join(this.root, `.tmp.tsconfig.${suffix}.json`)
        const currentTsconfig = path.join(this.root, this.wranglerConfig.config.config.tsConfig || 'tsconfig.json')
        const currentTsconfigContent: any = fs.existsSync(currentTsconfig) ? parseJSONC(fs.readFileSync(currentTsconfig, 'utf-8')) : {}
        const customTsconfigContent = {
            "extends": "./" + normalizePath(path.relative(path.dirname(tsconfigPath), currentTsconfig)),
            "compilerOptions": {
                "paths": {
                    // copying because they are not merged
                    ...(currentTsconfigContent.compilerOptions?.paths || {}),
                    "virtual:teenybase": ["./" + path.relative(path.dirname(currentTsconfig), tempConfigPath)],
                }
            }
        }
        fs.writeFileSync(tsconfigPath, JSON.stringify(customTsconfigContent, null, 2))
        this.writeWorkerConfigSnapshot(config, suffix)

        return tsconfigPath
    }

    removeCustomTsconfig(suffix: string){
        const tsconfigPath = path.join(this.root, `.tmp.tsconfig.${suffix}.json`)
        if(fs.existsSync(tsconfigPath))
        fs.unlinkSync(tsconfigPath)
        const tempConfigPath = path.join(this.root, '.teeny', `.tmp.config.${suffix}.json`)
        if(fs.existsSync(tempConfigPath))
        fs.unlinkSync(tempConfigPath)
    }

    /** Create a $DatabaseNode instance for direct D1 operations (setup, apply migrations, etc.). Not cached — settings may differ between calls. */
    getDb(settings: DatabaseSettings): $DatabaseNode {
        // @ts-expect-error check later, ts issue with D1Database return types from makeD1Binding
        return new $DatabaseNode(settings, makeD1Binding(this))
    }

    /** Cached apiRoute — avoids repeated disk reads within the same command. undefined = not loaded yet. */
    private _apiRoute: string | null | undefined = undefined
    /** Get apiRoute from infra.jsonc (handles legacy migration on first call). */
    async getApiRoute(skipConfirmation = false): Promise<string | undefined> {
        if (this._apiRoute === undefined) {
            const conf = await readProjectConfig(this, skipConfirmation)
            this._apiRoute = conf.apiRoute ?? null
        }
        return this._apiRoute ?? undefined
    }
    /** Save apiRoute to infra.jsonc and update cache. */
    setApiRoute(route: string): void {
        appendOrUpdateProjectConfig(this.root, apiRouteKey, route)
        this._apiRoute = route
    }
    /** Forget the cached apiRoute (after it was removed from infra.jsonc). */
    clearApiRoute(): void {
        this._apiRoute = null
    }
}

export function readMigrationsFolder(migrationsFolderPath: string) {
    // logger.info(`Reading Migrations folder: ${migrationsFolderPath}`)

    if (!fs.existsSync(migrationsFolderPath)) {
        fs.mkdirSync(migrationsFolderPath)
    }
    const fileNames = fs
        .readdirSync(migrationsFolderPath)
    let sqlNames = fileNames
        .filter((name) => name.endsWith(".sql"));
    // let configFile = fileNames.find((name) => name === 'config.json')
    let nextConfigFile = fileNames.find((name) => name === 'next-config.json')
    sqlNames.sort((a, b) => {
        const aNumber = parseInt(a.split("_")[0]);
        const bNumber = parseInt(b.split("_")[0]);
        return aNumber - bNumber;
    });

    const currentMigrations = sqlNames.map((name) => {
        const migrationPath = path.join(migrationsFolderPath, name);
        const migration = fs.readFileSync(migrationPath, "utf8");
        return {name, sql: migration};
    })
    let currentConfig, nextConfig
    // const configPath = configFile ? path.join(migrationsFolderPath, configFile) : null
    const nextConfigPath = nextConfigFile ? path.join(migrationsFolderPath, nextConfigFile) : null
    // try {
    //     currentConfig = configPath ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : undefined
    // }catch (e: any) {
    //     throw new Error(`Unable to read file ${readableRelative(configPath||'')}\n${e?.message || e}\n\nThis file is not supposed to be manually edited. You may revert any changes, or delete the "${readableRelative(migrationsFolderPath)}" and "${readableRelative(localPersist)}" directory and run again.`)
    // }
    try {
        nextConfig = nextConfigPath ? JSON.parse(fs.readFileSync(nextConfigPath, 'utf8')) : undefined
    } catch (e: any) {
        throw new Error(`Unable to read file ${readableRelative(nextConfigPath||'')}\n${e?.message || e}\n\nThis file is not supposed to be manually edited. You may try deleting the file and run again`)
    }
    return {migrations: currentMigrations, /*config: currentConfig, */nextConfig}
}

export type WranglerConfigRet = {
    config: {
        path: string
        config: any
    }
    db: { binding: string, database_id: string, database_name?: string, migrations_dir: string }
    migrations: string
}

export async function parseWrangler(root: string|undefined, options: GlobalCLIOptions, logger: Logger): Promise<WranglerConfigRet> {
    try {
        const projectRoot = normalizePath(root ? path.resolve(root) : process.cwd())
        const wranglerConfig = await loadWranglerConfigFromFile(projectRoot, options.wrangler, options.logLevel)
        const d1s = wranglerConfig.config.d1_databases
        if (!d1s?.length) throw new Error('No databases found in wrangler config')
        // const r2s = wranglerConfig.config.r2_buckets
        // if(!r2s?.length) new Error('No buckets found in wrangler config')
        const d1Binding = options.db ?? 'PRIMARY_DB'
        const d1 = d1s.find((d: any) => d.binding === (options.db || d1Binding))
        if (!d1) throw new Error(`Database binding ${d1Binding} not found in wrangler config. ` + (!options.db ? 'Use --db to specify a different database binding' : ''))
        const migrationsDir = d1.migrations_dir
        if (!migrationsDir) throw new Error('No migrations_dir found in wrangler config. Please specify a migrations_dir in wrangler config (like migrations)')
        return {config: wranglerConfig, db: d1, migrations: migrationsDir}
    }catch (e: any) {
        logger.error(
            colors.red(`error loading wrangler config:\n${e.stack}`),
            {error: e},
        )
        process.exit(1)
    }
}

export function readSecretsFile(c: CliContext, throwError = true) {
    // load secrets from .dev.vars or .prod.vars
    const secretsPath = path.join(c.root, c.isLocal ? devVars : prodVars)
    if (!fs.existsSync(secretsPath)) {
        if(throwError) {
            c.logger.error(`Secrets file not found at "${readableRelative(secretsPath)}". Run "teeny init" to generate it, or create it manually with ${adminTokenKey}=<value>.`)
            throw new Error(`Secrets file not found at ${secretsPath}`)
        }
        c.logger.debug(`Secrets file not found at "${readableRelative(secretsPath)}"`)
        return {}
    }
    const secrets = dotenv.parse(fs.readFileSync(secretsPath, 'utf8'))
    const adminToken = secrets[adminTokenKey] as string | undefined
    if (!adminToken && throwError) throw new Error(`Admin token(${adminTokenKey}) not found in secrets file at "${readableRelative(secretsPath)}"`)
    return {adminToken, secrets}
}

/**
 * Print endpoint info after deploy or dev start.
 * For remote: probes swagger/pocket to check if enabled. For local: prints all (no probing).
 */
export async function printEndpointInfo(baseUrl: string, isLocal: boolean, logger: Logger): Promise<void> {
    const varsFile = isLocal ? '.dev.vars' : '.prod.vars'
    const lines: string[] = [
        '',
        `  CRUD:    /api/v1/table/{table}/[select | list | view/:id | insert | update | edit/:id | delete]`,
        `  Auth:    /api/v1/table/{table}/auth/[sign-up | login-password | refresh-token | ...]`,
        `  Health:  ${baseUrl}/api/v1/health`,
    ]

    if (isLocal) {
        // Local dev: no probing, just print all
        lines.push(`  Swagger: ${baseUrl}/api/v1/doc/ui`)
        lines.push(`  Admin:   ${baseUrl}/api/v1/pocket/ (passwords in ${varsFile})`)
    } else {
        // Remote: probe endpoints
        const probe = async (path: string): Promise<boolean> => {
            try {
                const res = await fetch(`${baseUrl}${path}`, {signal: AbortSignal.timeout(5000)})
                return res.status === 200
            } catch { return false }
        }
        const [swaggerOk, pocketOk] = await Promise.all([
            probe('/api/v1/doc'),
            probe('/api/v1/pocket/'),
        ])
        if (swaggerOk) lines.push(`  Swagger: ${baseUrl}/api/v1/doc/ui`)
        else lines.push(`  Swagger: \x1b[2m✗ not enabled (add OpenApiExtension to your app)\x1b[0m`)
        if (pocketOk) lines.push(`  Admin:   ${baseUrl}/api/v1/pocket/ (passwords in ${varsFile})`)
        else lines.push(`  Admin:   \x1b[2m✗ not enabled (add PocketUIExtension to your app)\x1b[0m`)
    }

    for (const line of lines) logger.info(line)
}

/** Non-2xx response from the worker API (see {@link fetchWorker}). */
export class WorkerFetchError extends Error {
    constructor(message: string, public readonly status: number) {
        super(message)
        this.name = 'WorkerFetchError'
    }
}

/**
 * Right after a deploy the new worker version can take a few seconds to serve everywhere, and a
 * brand-new workers.dev hostname can take a moment to route (seen live: setup-db answered, and the
 * next request got Cloudflare's 404 "Page not found"). Meanwhile requests fail with 401/403 (a version
 * without the admin token answers), 404 (no route yet) or a network error.
 * With `networkErrors: false` only the HTTP statuses count: they prove the request was not processed,
 * while a timeout or reset may have hit the worker (use that for requests that aren't idempotent).
 * `serverErrors` also counts 5xx: for a redeploy whose previous version is known to be broken (bound
 * to a database that no longer exists), so its errors say nothing about the new version.
 */
export function isDeploymentWarmupError(e: any, networkErrors = true, serverErrors = false): boolean {
    if (e instanceof WorkerFetchError) return e.status === 401 || e.status === 403 || e.status === 404 || (serverErrors && e.status >= 500)
    if (!networkErrors) return false
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return true
    return e instanceof TypeError && /fetch failed/i.test(e.message) // undici network error (DNS, TLS, reset)
}

/** Waits before each retry of {@link fetchWorkerAfterDeploy}: about a minute in total. */
export const DEPLOY_WARMUP_RETRY_DELAYS_MS = [1000, 2000, 3000, 5000, 8000, 10000, 15000, 15000]

/**
 * {@link fetchWorker} for the first call to a worker that was just deployed: retries
 * {@link isDeploymentWarmupError} failures with backoff (one line of output, not one per attempt),
 * then rethrows the last error.
 */
export async function fetchWorkerAfterDeploy(c: CliContext, fPath: string, reqOptions?: RequestInit, opts: {delaysMs?: number[], networkErrors?: boolean, serverErrors?: boolean} = {}) {
    const delaysMs = opts.delaysMs ?? DEPLOY_WARMUP_RETRY_DELAYS_MS
    for (let attempt = 0; ; attempt++) {
        try {
            return await fetchWorker(c, fPath, reqOptions, false)
        } catch (e: any) {
            if (!isDeploymentWarmupError(e, opts.networkErrors ?? true, opts.serverErrors ?? false) || attempt >= delaysMs.length) throw e
            if (attempt === 0) c.logger.info('Waiting for the new deployment to go live...')
            c.logger.debug(`${fPath} not ready yet (${getErrorMessage(e)}), retry ${attempt + 1}/${delaysMs.length} in ${delaysMs[attempt]} ms`)
            await new Promise(r => setTimeout(r, delaysMs[attempt]))
        }
    }
}

export async function fetchWorker(c: CliContext, fPath: string, reqOptions?: RequestInit, logging = false, parseJson = true) {
    const {adminToken} = readSecretsFile(c, true)
    let apiRoute: string | undefined
    if (c.isLocal) {
        apiRoute = 'http://localhost:' + c.devServerPort
    } else {
        apiRoute = await c.getApiRoute()
    }
    const fOptions = {
        method: reqOptions?.method ?? 'GET',
        ...reqOptions,
        headers: {
            'Authorization': `Bearer ${adminToken}`,
            ...reqOptions?.headers,
        } as any,
        signal: reqOptions?.signal ?? AbortSignal.timeout(5000) // 5 second timeout
    }
    let _fetch = fetch
    if (c.isLocal) {
        // check if apiRoute is accessible and is a teenybase worker (not some other process on the same port)
        c.logger.debug('Checking if local dev server is running...')
        let devServerRunning = false
        let portInUseByOther = false
        if (apiRoute && !c.localWorker) {
            try {
                const r = await fetch(joinUrl(apiRoute, '/api/v1/health'), {
                    method: 'GET',
                    signal: AbortSignal.timeout(1000)
                })
                if (r.ok) {
                    const json = await r.json() as any
                    if (json?.status === 'ok') {
                        devServerRunning = true
                        c.logger.debug(`Dev server is running at ${apiRoute}${json.appName ? ` (${json.appName})` : ''}`)
                    } else {
                        portInUseByOther = true
                    }
                } else {
                    portInUseByOther = true
                }
            } catch (e: any) {
                // ECONNREFUSED = nothing on port (good, we can use it)
                // Anything else (empty reply, reset, timeout) = port is taken by something
                const code = e?.cause?.code
                if (code !== 'ECONNREFUSED') {
                    portInUseByOther = true
                }
            }
        }
        if (portInUseByOther) {
            // Mutate devServerPort so startLocal() binds to a free port and subsequent
            // fetchWorker calls resolve apiRoute to the new port.
            // This works because: (1) fetchWorker uses c.devServerPort for localhost in local mode,
            // (2) after startLocal(), c.localWorker is set so this health check is skipped.
            // todo: check if altPort is also in use before assigning (unlikely but possible)
            const altPort = 18787 + Math.floor(Math.random() * 1000)
            c.logger.debug(`Port ${c.devServerPort} is in use by another process (not a teenybase worker). Using port ${altPort} instead.`)
            c.devServerPort = altPort
        }
        if (!devServerRunning && !portInUseByOther) c.logger.debug('No dev server detected, using internal worker')
        if(devServerRunning && apiRoute) fPath = joinUrl(apiRoute, fPath)
        // @ts-expect-error check in next version, type mismatch between undici and cloudflare workers, but should be compatible
        else _fetch = c.localFetch.bind(c)
    } else {
        if(!apiRoute) throw new Error(`API route(${apiRouteKey}) not found in ${projectConfigFile}. Run \`teeny deploy --remote\` first, or manually add {"${apiRouteKey}": "https://your-worker-url"} to ${projectConfigFile}`)
        fPath = joinUrl(apiRoute, fPath)
    }
    if(logging){
        c.logger.info(`Fetching ${fOptions.method.toUpperCase()}:${fPath}`)
        if(fOptions.body) c.logger.info(fOptions.headers?.['Content-Type']==='application/json'?JSON.parse(fOptions.body as any):fOptions.body as any)
        if(fOptions.headers) c.logger.debug(`Headers: ${JSON.stringify(fOptions.headers)}`)
    }else {
        const debugBody = fOptions.body && typeof fOptions.body === 'string' && fOptions.body.length > 200
            ? fOptions.body.slice(0, 200) + `... (${fOptions.body.length} chars)`
            : fOptions.body
        c.logger.debug(`Fetching ${fOptions.method} ${fPath}${debugBody ? ` [body: ${debugBody}]` : ''}`)
    }
    const res = await _fetch(fPath, fOptions)
    const rest = await res.text()
    if(!res.ok) {
        // An HTML error page (e.g. Cloudflare's 404 while a new route propagates): show its title, not the page
        const htmlTitle = /^\s*</.test(rest) ? rest.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() : undefined
        let message = htmlTitle !== undefined ? `HTML page "${htmlTitle}"` : rest
        try{
            const json = JSON.parse(rest)
            const detail = json.error ?? json.data?.error
            message = [json.message, typeof detail === 'string' ? detail : (detail === undefined ? undefined : JSON.stringify(detail))]
                .filter(Boolean).join(' ') || rest
            if(logging) {
                c.logger.error(`Failed to fetch ${fPath}. Status: ${res.status}, Response: ${message}\n${JSON.stringify(json, null, 2)}`)
                c.logger.debug(`Failed response body: ${rest}`)
            }
        }catch (_e){}
        c.logger.debug(`Failed response body: ${rest}`)
        throw new WorkerFetchError(`Failed to fetch ${fPath}. Status: ${res.status}, Response: ${message.slice(0, 1024)}`, res.status)
    }
    try {
        return rest ? (parseJson ? JSON.parse(rest) : rest) : null
    }catch (e){
        throw new Error(`Failed to parse response from ${fPath}. Status: ${res.status}, Response: ${rest}`)
    }
}

export async function fetchDeployedMigrations(c: CliContext, settings: DatabaseSettings) {
    c.logger.debug(`Fetching deployed migrations from ${c.isLocal ? 'local' : 'remote'} deployment`)

    let migrations: DBMigration[]|null = null
    try {
        const db = c.getDb(settings)
        let noMigrationTable = false
        migrations = await db.migrationHelper.list().catch(e=>{
            c.logger.debug(e)
            // setup not done yet
            if (((e as D1Error).errorMessage || e.cause?.message || e.message)?.includes(`no such table: ${db.migrationHelper.tableName}`)) {
                c.logger.info('No migrations found in deployment')
                noMigrationTable = true
                return []
            }
            throw e
        })
        if (noMigrationTable) {
            return {settings: null, migrations, version: null}
        }
        // Nothing applied yet (e.g. an earlier deploy stopped after creating the tables): apply records its
        // rows in the same batch that writes $settings, so there are no settings either. Checked before
        // dbSettings(), which needs a batch that the direct path can't run (cli-direct-d1-batch-unsupported).
        if (!migrations.length) return {settings: null, migrations, version: null}
        const dbState = await db.migrationHelper.dbSettings()
        if (!dbState.settings) {
            throw new Error('No settings found in the database state.')
        }
        return {...dbState, migrations}
    }catch (e) {
        c.logger.debug(e as any)
        if (c.databaseIdChanged) {
            // The deployed worker is still bound to the previous database, so its API can't answer for this one
            throw new Error(`Couldn't read the deployed migrations from the database ${c.wranglerConfig.db.database_id} (${getErrorMessage(e)}), and the deployed worker is still bound to the previous database, so its API can't be used for it. Point database_id at an empty database (or TEENY_AUTO_CREATE) and deploy again.`)
        }
        c.logger.debug('Fallback to fetch migrations and settings through API.')
        // throw e
        try {
            const json = await fetchWorker(c, '/api/v1/migrations', {}).catch(e => {
                // setup not done yet
                if (e.message?.includes(`no such table: ${MigrationHelperRaw.DEFAULT_TABLE_NAME}`)) {  // todo migration table name is fixed
                    c.logger.info('No migrations found in deployment')
                    return {settings: null, migrations: [], version: null}
                }
                // if 404, then also the same thing
                if (e.message?.includes(`/api/v1/migrations. Status: 404`)) {
                    c.logger.info('No migrations found in deployment (404 from API)')
                    return {settings: null, migrations: [], version: null}
                }
                throw e
            })
            return json as { settings: DatabaseSettings | null, migrations: DBMigration[], version: number | null }
        } catch (e) {
            // if(migrations){
            //     return {settings, migrations, version}
            // }
            throw e
        }
    }
}

export function loadLocalPersistConfig(c: CliContext) {
    if(!c.isLocal) return undefined
    const localConfigPath = path.join(c.localPersistPath, 'config.json')
    if (fs.existsSync(localConfigPath)) {
        let localConfig
        try {
            localConfig = JSON.parse(fs.readFileSync(localConfigPath, 'utf8'))
        } catch (e: any) {
            throw new Error(`Unable to read file ${readableRelative(localConfigPath || '')}\n${e?.message || e}\n\nThis file is not supposed to be manually edited. You may revert any changes, or delete the "${readableRelative(c.localPersistPath)}" directory and run again.`)
        }
        // // write to migrations/config.json so that fetchDeployedMigrations below can use it in local dev server. if clean is true, this will be deleted.
        // if(!fs.existsSync(c.migrationsPath)) fs.mkdirSync(c.migrationsPath, {recursive: true})
        // const configPath = path.join(c.migrationsPath, 'config.json')
        // fs.writeFileSync(configPath, JSON.stringify(localConfig, null, 2))
        // c.logger.info(`Config found in ${readableRelative(c.localPersistPath)}. Written to ${readableRelative(configPath)}`)
        return localConfig ? databaseSettingsSchema.parse(localConfig) : undefined
        // return true
    }
    return undefined
}

export async function generateMigrationsDir(c: CliContext, clean = false, write = true) {
    c.logger.section?.('Generating migrations')

    const config = await loadConfigFromFile(c.root, c.options.config, c.options.logLevel)

    // Fail before any D1 / deploy call: a table with neither rules nor `public: true` is default-deny at
    // runtime, which is almost never intended. Covers generate, deploy (and the migrate alias) and build.
    assertTablesHaveAccessPolicy(config.config)

    let deployed = true // todo name to deployedMigrations
    let lastConfig: DatabaseSettings|undefined = undefined
    let lastMigrations: DBMigration[] = []
    // CAS token for MigrationHelperRaw.apply — read from $settings_version, echoed back
    // so the apply's CAS statement can detect concurrent applies. null = fresh DB.
    let lastVersion: number | null = null

    let {migrations: currentMigrations, /*config: currentConfig, */nextConfig: _nextConfig} = readMigrationsFolder(c.migrationsPath)

    // the local server cannot be running/deployed when there is no config.json as it's supposed to directly import it.
    if(c.isLocal && deployed){
        // check if there is a config in localpersist
        const hasLocalConfig = !!loadLocalPersistConfig(c)

        if(!hasLocalConfig) {
            c.logger.debug(`No config found at ${readableRelative(c.localPersistPath)}`)
            deployed = false
        }
    }

    if(!c.isLocal && deployed){
        // check if deployed if infra.jsonc has apiRoute, then we assume its deployed. todo not a good check, we have to check if the url matches the worker name
        // const projectConf = await readProjectConfig(c)
        // if(!projectConf.apiRoute) {
        //     c.logger.warn(`No API route(${apiRouteKey}) found in ${projectConfigFile}. Assuming not deployed and generating migrations from scratch\n`)
        //     deployed = false
        // }

        if(c.wranglerConfig.db.database_id.startsWith(AUTO_CREATE)) {
            c.logger.debug(`Database ${c.wranglerConfig.db.binding} is a placeholder, assuming not deployed`)
            deployed = false
        }
    }

    if (deployed) {
        const json = await fetchDeployedMigrations(c, config.config)
        if(json.settings === null) deployed = false

        lastConfig = json.settings ? databaseSettingsSchema.parse(json.settings) : undefined
        lastMigrations = json.migrations
        lastVersion = json.version
    } else {
        // do nothing?
    }

    if(!clean && write){
        // check current folder state since we are not cleaning

        // compare with the last config
        // if different, throw error
        // todo proper check
        const migrationsChanged = jsonStringify(currentMigrations) !== jsonStringify(lastMigrations)
        // const configChanged = jsonStringify(currentConfig||{}) !== jsonStringify(lastConfig||{})
        if (migrationsChanged) {
            throw new Error('Migrations folder has been modified. Apply the migrations first or run with --clean to reset migrations from deployment')
        }
        // if (configChanged) {
        //     throw new Error('Config has been modified. Deploy first or run with --clean to reset migrations from deployment')
        // }

        c.logger.debug(`Migrations folder and config are up to date with the ${c.isLocal ? 'local' : 'remote'} deployment`)
    }

    const index = nextUserIndex(lastMigrations)
    const {migrations: newMigrations, config: nextConfig_, extraLogs} = generateMigrations(config.config, lastConfig, index)
    const comment = `Config generated by teenybase on ${new Date().toISOString()}. Do not modify this file.`
    const nextConfig = nextConfig_ ? {
        '//': comment,
        ...nextConfig_
    } : undefined

    if (clean) {
        if(!write) throw new Error('Cannot run with clean with no write')
        // delete all sql files
        for (const m of currentMigrations) {
            fs.unlinkSync(path.join(c.migrationsPath, m.name))
        }
        // delete config file
        // if (currentConfig) {
        //     fs.unlinkSync(path.join(c.migrationsPath, 'config.json'))
        // }
        // delete any next-config.json file from previous runs
        if (_nextConfig){
            const nextConfigCleanPath = path.join(c.migrationsPath, 'next-config.json')
            if(fs.existsSync(nextConfigCleanPath)) {
                fs.unlinkSync(nextConfigCleanPath)
            }
        }
        // c.logger.info('cleaning lastMigrations ' + lastMigrations.map(m=>m.name).join('\n'))
        for (const m of lastMigrations) {
            fs.writeFileSync(path.join(c.migrationsPath, m.name), m.sql)
        }
        for (const m of currentMigrations) {
            if(lastMigrations.find(m1=>m1.name === m.name)) continue
            if(fs.existsSync(path.join(c.migrationsPath, m.name))) {
                c.logger.warn(`Deleting extra file in ${c.migrationsPath} - ${m.name}`)
                fs.unlinkSync(path.join(c.migrationsPath, m.name))
            }
        }
        // write the config from the deployment
        // if (lastConfig) {
        //     fs.writeFileSync(path.join(c.migrationsPath, 'config.json'), JSON.stringify(lastConfig, null, 2))
        // }
        c.logger.debug('Migrations folder cleaned' + (deployed ? ' and reset to deployment' : ''))
        // currentMigrations = []
        // currentConfig = undefined
    }else {
        //
    }

    // when there are no changes, nextConfig is null
    if(!nextConfig){
        c.logger.info('No changes detected in database config')
        // if(clean){
        //     if(!write) throw new Error('Cannot run with clean with no write')
        //     // delete any next-config.json file from previous runs
        //     if (_nextConfig){
        //         fs.unlinkSync(path.join(c.migrationsPath, 'next-config.json'))
        //     }
        //     // there could be a mismatch between the migrations we have on disk and what's supposed to be, but that's fine since it will be checked when we actually need to apply anything
        // }
        return {newMigrations: [], nextConfig: undefined, lastMigrations, lastConfig, lastVersion, deployed/*, currentConfig*/}
    }

    if(write) {
        // write new migrations
        for (const {name, sql, logs} of newMigrations) {
            const migrationPath = path.join(c.migrationsPath, name)
            const comment = `-- Migration number: ${name.split('_')[0]} generated by teenybase on ${new Date().toISOString()}. Do not modify this file.`
            fs.writeFileSync(migrationPath, [comment, sql].join('\n\n'))
            c.logger.debug(`New migration generated - ${name}`)
            for (const log of logs) {
                // Strip leading ✔ from SQL schema logs — success() adds its own
                c.logger.success?.(log.replace(/^✔\s*/, ''))
            }
        }
        if (!newMigrations.length) {
            c.logger.debug('No new migrations generated')
        }
        // write config
        const configPath = path.join(c.migrationsPath, 'next-config.json')
        fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2))
        c.logger.debug(`Config generated and written to - ${readableRelative(configPath)}`)
        if(extraLogs?.length){
            for (const log of extraLogs) {
                c.logger.warn(log)
            }
        }
        if (newMigrations.length) c.logger.info('') // visual break after generation output
    }

    return {newMigrations, nextConfig, lastMigrations, lastConfig, lastVersion, deployed/*, currentConfig*/}
}

/**
 * `wrangler deploy` with the given settings bundled. Returns the workers.dev route on a first deploy.
 * `secretsFile` (a JSON file of name → value) uploads secrets as part of the same deployment
 * (`wrangler deploy --secrets-file`), so the new version never runs without them.
 */
export async function wranglerDeploy(c: CliContext, config: DatabaseSettings, first = false, secretsFile?: string): Promise<string | undefined> {
    if(c.isLocal) throw new Error('Cannot deploy with --local')

    try {
        // todo switch to spawn so cleanup (removeCustomTsconfig) runs even if process is killed
        const {stdout: resB} = await c.runWrangler([
            'deploy', c.wranglerConfigFlag, `--tsconfig=${c.createCustomTsconfigForWorker(config, 'deploy')}`,
            ...(secretsFile ? [`--secrets-file=${secretsFile}`] : []),
        ])

        if (!first) return undefined

        // c.logger.info(resB)
        // setup-db is done just before migrations

        // find deployment route (strip ANSI escape codes first — wrangler adds formatting)
        const cleanOutput = resB.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
        let route = cleanOutput.match(/https:\/\/[a-zA-Z0-9-.]+\.workers\.dev\r?\n.*Current Version ID:/gm)?.[0].split('\n')[0]
        // if(!route) route = resB.match(/\n[a-zA-Z0-9-.]+ (custom domain)\n*Current Version ID:/gm)?.[0].split('\n').map(r=>'https://'+r)[0]

        return route
    }catch (e: any) {
        const err = e instanceof WranglerCommandError ? e.output : (e.message || String(e))

        // wrangler's output was already shown for a WranglerCommandError
        if (!(e instanceof WranglerCommandError)) c.logger.error(err)
        const bucketNotFound = err.includes('workers.api.error.bucket_not_found [code: 10085]')
        if(bucketNotFound) {
            c.logger.error('Bucket specified in wrangler config is not found. Create a bucket in cloudflare using wrangler and set it in wrangler config')
            // throw e
        }
        throw new Error(`Unable to deploy worker: ${e instanceof WranglerCommandError ? e.message : 'check logs above for more details.'}`)
    } finally {
        c.removeCustomTsconfig('deploy')
    }
}

/**
 * Append or update a key=value in a dotenv-style file without clobbering other entries.
 */
function appendOrUpdateFile(filePath: string, key: string, value: string): void {
    let content = ''
    if (fs.existsSync(filePath)) {
        content = fs.readFileSync(filePath, 'utf8')
    }
    const lines = content.split('\n')
    const idx = lines.findIndex(l => l.trimStart().startsWith(key + '='))
    const newLine = `${key}=${value}`
    if (idx >= 0) {
        lines[idx] = newLine
    } else {
        // Append, ensuring there's a newline before if file doesn't end with one
        if (lines.length > 0 && lines[lines.length - 1] === '') {
            lines[lines.length - 1] = newLine
            lines.push('')
        } else {
            lines.push(newLine)
        }
    }
    fs.writeFileSync(filePath, lines.join('\n'))
}

/**
 * Append or update a key=value in .prod.vars without clobbering other entries.
 */
export function appendOrUpdateProdVars(root: string, key: string, value: string): void {
    appendOrUpdateFile(path.join(root, prodVars), key, value)
}

/**
 * Set a key in the infra.jsonc project config file using JSONC-aware modify.
 */
export function appendOrUpdateProjectConfig(root: string, key: string, value: string): void {
    const filePath = path.join(root, projectConfigFile)
    let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '{}'
    const edits = jsoncModify(content, [key], value, {formattingOptions: {insertSpaces: true, tabSize: 2}})
    fs.writeFileSync(filePath, jsoncApplyEdits(content, edits))
}

/** Remove a key from the infra.jsonc project config file (no-op if the file or key is missing). */
export function removeProjectConfigKey(root: string, key: string): void {
    const filePath = path.join(root, projectConfigFile)
    if (!fs.existsSync(filePath)) return
    const content = fs.readFileSync(filePath, 'utf8')
    const edits = jsoncModify(content, [key], undefined, {formattingOptions: {insertSpaces: true, tabSize: 2}})
    fs.writeFileSync(filePath, jsoncApplyEdits(content, edits))
}

/**
 * Read the infra.jsonc project config file. Returns extracted values.
 * Migrates from legacy .prod.vars API_ROUTE if infra.jsonc doesn't exist yet.
 */
export async function readProjectConfig(c: CliContext, skipConfirmation = false): Promise<{ apiRoute: string | undefined }> {
    const configPath = path.join(c.root, projectConfigFile)

    // todo: remove migration block in Jun 2026
    // Migrate API_ROUTE from .prod.vars to infra.jsonc if needed
    if (!fs.existsSync(configPath)) {
        const prodVarsPath = path.join(c.root, prodVars)
        if (fs.existsSync(prodVarsPath)) {
            const parsed = dotenv.parse(fs.readFileSync(prodVarsPath, 'utf8'))
            const legacyRoute = parsed['API_ROUTE']?.trim()
            if (legacyRoute) {
                if (!skipConfirmation) {
                    const ok = await ask<boolean>({
                        type: 'confirm',
                        message: `Found API_ROUTE in ${prodVars}. Migrate to ${projectConfigFile}?`,
                        initial: true,
                    }, 'Pass --yes to migrate it.')
                    if (!ok) {
                        c.logger.warn(`Skipped migration. Manually create ${projectConfigFile} with {"${apiRouteKey}": "${legacyRoute}"}`)
                        return { apiRoute: undefined }
                    }
                }
                appendOrUpdateProjectConfig(c.root, apiRouteKey, legacyRoute)
                // Remove API_ROUTE from .prod.vars
                const content = fs.readFileSync(prodVarsPath, 'utf8')
                const lines = content.split('\n').filter(l => !l.trimStart().startsWith('API_ROUTE='))
                fs.writeFileSync(prodVarsPath, lines.join('\n'))
                c.logger.info(`Migrated API_ROUTE from ${prodVars} to ${projectConfigFile}`)
            }
        }
    }

    let config: Record<string, any> = {}
    if (fs.existsSync(configPath)) {
        config = jsoncParse(fs.readFileSync(configPath, 'utf8')) ?? {}
    }

    let apiRoute = (typeof config[apiRouteKey] === 'string' ? config[apiRouteKey].trim() : undefined) || undefined

    // Normalize empty/invalid values
    if (apiRoute) {
        const lower = apiRoute.toLowerCase().trim()
        if (!lower || lower === 'null' || lower === 'undefined' || lower === 'na' || lower === 'none') {
            apiRoute = undefined
        }
    }

    return { apiRoute }
}

export function localPersistDeploy(lastConfig: Partial<DatabaseSettings>|undefined, c: CliContext){
    const localConfigPath = path.join(c.localPersistPath, 'config.json')
    if(lastConfig) {
        fs.mkdirSync(path.dirname(localConfigPath), {recursive: true})
        // Atomic, because a running `teeny dev` polls this file (watchLocalPersistConfig).
        writeFileAtomic(localConfigPath, JSON.stringify(lastConfig, null, 2))
    }else if(fs.existsSync(localConfigPath)) fs.unlinkSync(localConfigPath)

}

/** Write via a temp file + rename so readers never see a partially written file. */
function writeFileAtomic(filePath: string, content: string) {
    const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(tmpPath, content)
    try {
        fs.renameSync(tmpPath, filePath)
    } catch (e) {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
        throw e
    }
}

/**
 * Call `onChange` with the validated settings whenever the content of .local-persist/config.json
 * changes (it is rewritten by `deploy --local` after migrations are applied). Polls with
 * fs.watchFile, which also notices the file being replaced. An unreadable or invalid file is
 * reported and skipped; the previous settings stay in use. Returns a function that stops watching.
 */
export function watchLocalPersistConfig(c: CliContext, onChange: (config: DatabaseSettings) => void, intervalMs = 500): () => void {
    const configPath = path.join(c.localPersistPath, 'config.json')
    let lastContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : undefined
    const listener = (curr: fs.Stats) => {
        if (!curr.mtimeMs) return // removed; keep serving the last settings
        let content: string
        try {
            content = fs.readFileSync(configPath, 'utf8')
        } catch {
            return // removed between the stat and the read
        }
        if (content === lastContent) return
        lastContent = content
        let config: DatabaseSettings | undefined
        try {
            config = loadLocalPersistConfig(c)
        } catch (e: any) {
            c.logger.warn(`Ignoring the changed ${readableRelative(configPath)}: ${getErrorMessage(e)}`)
            return
        }
        if (config) onChange(config)
    }
    fs.watchFile(configPath, {interval: intervalMs}, listener)
    return () => fs.unwatchFile(configPath, listener)
}

/** Write secrets (name → value) as JSON, readable only by the current user. */
function writeTempSecretsFile(file: string, secrets: Record<string, string>): void {
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(file, JSON.stringify(secrets, null, 2), {mode: 0o600})
    fs.chmodSync(file, 0o600)
}

export async function deploySecrets(c: CliContext, secrets: any){
    if(c.isLocal) throw new Error('Cannot deploy with --local')
    const secretCount = secrets ? Object.keys(secrets).length : 0
    if (!secretCount) {
        c.logger.warn('No secrets to upload')
        return
    }
    const tempSecretsPath = path.join(c.root, '.teeny', '.temp-secrets.json')
    try {
        writeTempSecretsFile(tempSecretsPath, secrets)
        // todo switch to spawn so cleanup (temp-secrets.json deletion) runs even if process is killed
        await c.runWrangler(['secret', 'bulk', c.wranglerConfigFlag, tempSecretsPath], {echo: false})
        c.logger.info(`Uploaded ${secretCount} secret(s) successfully`)
    }catch (e: any) {
        const detail = e instanceof WranglerCommandError ? `${e.message}\n${e.output}` : (e.stderr || e.stdout || e.output || e.message || String(e))
        throw new Error(`Unable to deploy secrets from ${c.isLocal ? devVars : prodVars}.\n${detail}`)
    }finally {
        if(fs.existsSync(tempSecretsPath)) fs.unlinkSync(tempSecretsPath)
    }
}

export async function migrateAndDeploy(c: CliContext, clean: boolean, doMigrate: boolean, forceDeploy: boolean, skipConfirmation: boolean = false) {
    const {newMigrations, nextConfig, lastConfig, lastVersion} = await generateMigrationsDir(c, clean).catch(async e => {
        throw e
    })
    if (newMigrations?.length) {
        if (!doMigrate) {
            throw new Error('There are unapplied migrations. Run with --migrate to apply them')
        }
    }
    let newSettingsSavedInDb = false
    // Post-line-1605 code reads `nextConfig` only as a boolean ("is there a new schema to
    // apply?"). The object itself is stale (no version stamp); use `deploySettings` for content.
    const hasNextConfig = !!nextConfig

    const {migrations, /*config: lastConfig, */nextConfig: _nextConfig} = readMigrationsFolder(c.migrationsPath)
    try {
        // this check is not obsolete, don't remove
        if (JSON.stringify(nextConfig||{}) !== JSON.stringify(_nextConfig||{})) {
            throw new Error('Unknown error: nextConfig does not match locally')
        }
        // if (nextConfig) {
        //     c.logger.info('Updating config.json with next-config.json')
        //     fs.writeFileSync(path.join(c.migrationsPath, 'config.json'), JSON.stringify(nextConfig, null, 2))
        // }

        // let deployed = false

        const shouldDeploy = !!nextConfig || newMigrations?.length || forceDeploy
        if(shouldDeploy) {
            const workerName = c.wranglerConfig.config.config.name
            if (!workerName) {
                throw new Error('Required - No worker name(name) found in wrangler config')
            }

            let currentDeployments = []
            let deployRoute = undefined as string|undefined
            let cfAccountId: string | undefined
            let accountLabel = '' // for messages
            let databaseCreated = false
            if(!c.isLocal) {
                if (c.isTemporary) {
                    // prepareTemporaryAccount (initContext) picked the account; wrangler uses it under --temporary
                    if (!c.temporaryAccount) throw new Error('Temporary account not prepared')
                    cfAccountId = c.temporaryAccount.id
                    accountLabel = `temporary account "${c.temporaryAccount.name}"`
                } else {
                    cfAccountId = await resolveDeployAccountId(c, skipConfirmation)
                    // wrangler subcommands (auto-create, deploy) use it too, also when it was just discovered
                    if (!process.env.CLOUDFLARE_ACCOUNT_ID) process.env.CLOUDFLARE_ACCOUNT_ID = cfAccountId
                    accountLabel = `account ${cfAccountId}`
                }

                // Auto-create resources from TEENY_AUTO_CREATE placeholders before deploying
                const databaseIdBefore = c.wranglerConfig.db.database_id
                await autoCreateResources(c, skipConfirmation)
                databaseCreated = databaseIdBefore.startsWith(AUTO_CREATE) && c.wranglerConfig.db.database_id !== databaseIdBefore

                // get current deployments from wrangler
                try {
                    c.logger.debug('Fetching current deployments')
                    // Silent: suppress wrangler's stderr — CLI handles the error itself
                    // (wrangler prints [ERROR] for non-existent workers, which is expected for first deploys)
                    const cdRes = await c.runWrangler(['deployments', 'list', c.wranglerConfigFlag, '--json'], {echo: false})
                    currentDeployments = JSON.parse(cdRes.stdout)
                }catch (e: any) {
                    const err = e instanceof WranglerCommandError ? e.output.trim() : getErrorMessage(e)
                    c.logger.debug(err)
                    const noDeployment = err.includes('[code: 10007]')
                    if(!noDeployment) {
                        c.logger.error(`Unknown error when fetching previous deployments of the worker ${workerName} in Cloudflare ${accountLabel}. Please try again later.`)
                        c.logger.error(err)
                        throw e
                    }else {
                        // do nothing
                    }
                }

                // if deployed and api route set in infra, todo check if the route goes to the same worker
                // if(currentDeployments.length && apiRoute){
                //     if(lastConfig) {
                //         // db is deployed and worker is deployed
                //     }
                //
                //     // todo
                // }

            }

            const dbExists = !!lastConfig
            const workerExists = !!currentDeployments.length
            // The worker exists but its database_id changed in this run (created, or swapped for an
            // existing database): the deployed worker is still bound to the old id, so it has to be
            // redeployed before the database can be set up or migrated through it.
            const rebindWorker = workerExists && (databaseCreated || c.databaseIdChanged)

            // Ask before the worker is deployed, secrets are generated or the database is touched,
            // so that a "no" (or a missing --yes in a non-interactive shell) changes nothing there.
            // (With --remote, account_id selection and auto-created resources above come first.)
            if (newMigrations?.length) {
                const message = `About to apply ${newMigrations.length} migration(s)\n Your database may not be available to serve requests during the migration, continue?`
                if (!skipConfirmation) {
                    const ok = await ask<boolean>({
                        type: 'confirm',
                        message: message,
                        initial: false,
                    }, 'Pass --yes to apply them.')
                    if (!ok) {
                        throw new Error('Migration cancelled by user')
                    }
                } else {
                    c.logger.debug(message)
                }
            }

            // ── Phase 1: Ensure worker is deployed ──
            // This phase only cares about the worker, not the DB state.
            // Secrets are always deployed when the worker is new.
            if ((!workerExists || rebindWorker) && nextConfig) {
                if (!c.isLocal) {
                    // todo readSecretsFile should not log error now, that error should be logged later if auto generate is not possible
                    const envSec = readSecretsFile(c, false)

                    // todo move to util in another file
                    // Auto-generate missing secrets before first deploy
                    {
                        const existingSecrets = envSec.secrets || {}
                        let modified = false

                        // 1. Scan config for $-prefixed strings
                        const configStr = JSON.stringify(nextConfig)
                        const allSecretRefs = [...new Set(
                            [...configStr.matchAll(/"\$([A-Z_][A-Z0-9_]*)"/g)].map(m => m[1])
                        )]

                        // 2. Identify which are auto-generatable (known config paths)
                        const autoGenNames = new Set<string>()

                        // settings.jwtSecret
                        if (typeof nextConfig.jwtSecret === 'string' && nextConfig.jwtSecret.startsWith('$')) {
                            autoGenNames.add(nextConfig.jwtSecret.slice(1))
                        }

                        // settings.tables[].extensions[name="auth"].jwtSecret
                        for (const table of nextConfig.tables || []) {
                            for (const ext of table.extensions || []) {
                                if (ext.name === 'auth' && typeof ext.jwtSecret === 'string' && ext.jwtSecret.startsWith('$')) {
                                    autoGenNames.add(ext.jwtSecret.slice(1))
                                }
                            }
                        }

                        // Always required runtime env secrets
                        autoGenNames.add(adminTokenKey)
                        autoGenNames.add('ADMIN_JWT_SECRET')
                        autoGenNames.add('POCKET_UI_VIEWER_PASSWORD')
                        autoGenNames.add('POCKET_UI_EDITOR_PASSWORD')

                        // 3. Generate missing auto-generatable secrets
                        const toGenerate: string[] = []
                        for (const name of autoGenNames) {
                            if (!existingSecrets[name]) toGenerate.push(name)
                        }

                        // 4. Find user-provided secrets that are missing
                        const toWarn: string[] = []
                        for (const name of allSecretRefs) {
                            if (!autoGenNames.has(name) && !existingSecrets[name]) toWarn.push(name)
                        }

                        if (toGenerate.length) {
                            // Prompt user (unless --yes)
                            if (!skipConfirmation) {
                                console.log()
                                const ok = await ask<boolean>({
                                    type: 'confirm',
                                    message: `Generate ${toGenerate.length} missing secret(s) in ${prodVars}?\n  ${toGenerate.join(', ')}`,
                                    initial: true,
                                }, 'Pass --yes to generate them.')
                                if (!ok) throw new Error('Cancelled — create secrets manually in ' + prodVars)
                            }
                            try {
                                for (const name of toGenerate) {
                                    const value = crypto.randomBytes(32).toString('hex')
                                    appendOrUpdateProdVars(c.root, name, value)
                                }
                                c.logger.info(`Generated ${toGenerate.length} secret(s) in ${prodVars}: ${toGenerate.join(', ')}`)
                            } catch (e: any) {
                                throw new Error(`Failed to write secrets to ${prodVars}: ${e.message}`)
                            }
                            modified = true
                        }

                        if (toWarn.length) {
                            for (const name of toWarn) {
                                appendOrUpdateProdVars(c.root, name, '')
                            }
                            c.logger.warn(`Added ${toWarn.length} empty secret(s) to ${prodVars} — fill in before using: ${toWarn.join(', ')}`)
                            c.logger.warn(`Run 'teeny secrets --upload --remote' after filling in the values.`)
                            modified = true
                        }

                        // Re-read secrets file if modified
                        if (modified) {
                            Object.assign(envSec, readSecretsFile(c, false))
                        }
                    }

                    if (rebindWorker) {
                        const message = `The worker ${workerName} exists but is bound to a different database. About to redeploy it with the database in the wrangler config and upload the secrets in ${prodVars}.`
                        if (!skipConfirmation) {
                            console.log()
                            const ok = await ask<boolean>({
                                type: 'confirm',
                                message: message + ' Continue?',
                                initial: true,
                            }, 'Pass --yes to continue.')
                            if (!ok) throw new Error('Deployment cancelled by user')
                        } else {
                            console.log()
                            c.logger.info(message)
                        }
                    } else if (dbExists) {
                        // State 3: DB exists but worker is gone — redeploy worker to existing DB
                        // todo proper message
                        const message = `Database has existing migrations but no worker found. About to redeploy the worker ${workerName} and upload secrets.`
                        if (!skipConfirmation) {
                            console.log()
                            const ok = await ask<boolean>({
                                type: 'confirm',
                                message: message + ' Continue?',
                                initial: true,
                            }, 'Pass --yes to continue.')
                            if (!ok) {
                                throw new Error('Deployment cancelled by user')
                            }
                        } else {
                            console.log()
                            c.logger.info(message)
                            c.logger.info('Continuing with re-deployment (--yes flag provided)')
                        }
                    } else {
                        // State 1: Fresh deploy — no worker, no DB
                        // todo check if cloudflare/teeny login or throw error/show warning/trigger login
                        const message = `About to deploy the worker for the first time and upload all the secrets in ${prodVars} with the name ${workerName} in ${accountLabel}`
                        if (!skipConfirmation) {
                            console.log()
                            const ok = await ask<boolean>({
                                type: 'confirm',
                                message: message + ', continue?',
                                initial: true,
                            }, 'Pass --yes to continue.')
                            if (!ok) {
                                throw new Error('First time deployment cancelled by user')
                            }
                        } else {
                            console.log()
                            c.logger.info(message)
                            c.logger.info('Continuing with first time deployment (--yes flag provided)')
                        }
                    }

                    const secretCount = Object.keys(envSec.secrets ?? {}).length
                    const secretsWithDeploy = secretCount > 0 && versionAtLeast(resolveWranglerPackage(c.root).version, WRANGLER_MIN_SECRETS_FILE)
                    {
                        try {
                            c.logger.info('\nDeploying worker') // todo color this and other messages like this

                            // write without tables first (because its first time deployment without any migrations)
                            const configNoTables = {
                                ...nextConfig, tables: []
                            } as DatabaseSettings

                            // Secrets go up with this deployment (--secrets-file) when wrangler supports it,
                            // so the worker never serves without its admin token. Older wrangler: `secret bulk` below.
                            const tempSecretsPath = path.join(c.root, '.teeny', '.temp-secrets.json')
                            let route: string | undefined
                            try {
                                if (secretsWithDeploy) writeTempSecretsFile(tempSecretsPath, envSec.secrets!)
                                route = await wranglerDeploy(c, configNoTables, true, secretsWithDeploy ? tempSecretsPath : undefined)
                            } finally {
                                if (fs.existsSync(tempSecretsPath)) fs.unlinkSync(tempSecretsPath)
                            }
                            if (secretsWithDeploy) c.logger.info(`Uploaded ${secretCount} secret(s) with the deployment`)
                            if (!route) {
                                // check if there is custom domain in wrangler config
                                // { pattern = "subdomain.example.com", custom_domain = true }
                                const customDomain = c.wranglerConfig.config.config.routes?.find((r: any) => r.custom_domain)?.pattern
                                if (customDomain) route = `https://${customDomain}`
                            }
                            if (!route) {
                                c.logger.error('Unknown error after deploying worker. Deployment route not found.')
                            } else {
                                deployRoute = route
                                // Save apiRoute immediately so failed setup-db doesn't block re-deploys
                                c.setApiRoute(deployRoute)
                            }
                        } catch (e) {
                            // c.logger.error('Unknown error when deploying worker, secrets during first deployment.')
                            throw e
                        } finally {
                            // revert config to nextConfig
                            // fs.writeFileSync(path.join(c.migrationsPath, 'config.json'), JSON.stringify(nextConfig, null, 2))
                        }
                        // secrets (wrangler older than WRANGLER_MIN_SECRETS_FILE, or none to upload)
                        if (!secretsWithDeploy) try {
                            await deploySecrets(c, envSec.secrets)
                        } catch (e) {
                            c.logger.error(`Unknown error when deploying worker, secrets during first deployment. Cannot continue. First, run "teeny secrets --remote --upload" then set the ${apiRouteKey} in ${projectConfigFile} and rerun the command to deploy.`)
                            throw e
                        }
                    }

                    // deployed = true
                } else {
                    // Local deploy, nothing to do with wrangler. .local-persist/config.json is only
                    // written after the migrations are applied (Phase 3), so a failed or cancelled
                    // run can't leave a config that claims a schema the database doesn't have.
                    // Until then the internal worker (worker API fallback below) runs with nextConfig.
                    c.localWorkerSettings = nextConfig
                }
            }

            // Stamp the pending version onto the config apply will commit. apply enforces
            // `settings.version === (lastVersion ?? -1) + 1` so `$settings` blob + `$settings_version`
            // KV row land in sync. Same stamped object is bundled into the worker in Phase 3.
            const pendingVersion = (lastVersion ?? -1) + 1
            const deploySettings: DatabaseSettings | undefined = (nextConfig || lastConfig) && {...(nextConfig || lastConfig)!, version: pendingVersion}

            // ── Phase 2: Ensure DB is set up + apply migrations ──
            // Primary: direct D1 via wrangler d1 execute (no worker needed).
            // Fallback: worker API via fetchWorker (needs apiRoute).
            if (hasNextConfig || newMigrations?.length) {

                if (!dbExists && workerExists && !rebindWorker) {
                    // State 2: Worker exists but DB is empty — warn user before applying from scratch
                    // (could indicate wrong DB binding, partial previous deploy, etc.)
                    const apiRoute = await c.getApiRoute(skipConfirmation)
                    const message = `Worker is already deployed but no settings and migrations found at ${apiRoute || deployRoute}`
                    if (!skipConfirmation) {
                        const ok = await ask<boolean>({
                            type: 'confirm',
                            message: message + '\nDo you want to continue and apply migrations from scratch?',
                            initial: false,
                        }, 'Pass --yes to continue.')
                        if (!ok) {
                            throw new Error('Deployment cancelled by user.')
                        }
                    } else {
                        c.logger.info(message)
                        c.logger.info('Continuing with migration (--yes flag provided)')
                    }
                }

                // todo issue, check now after fix -
                //  after deploying the worker (either first time or subsequent),
                //  it is possible that it breaks the deployment (like when jwt secret cannot be resolved).
                //  after that when calling setup-db, it returns an error
                //  to reproduce -
                //   delete local-persist in the notes-sample, change JWT_SECRET_MAIN to ABC in teenybase.ts and run migrate.
                //   other way - in an existing deployment, make the same change in .local-persist/config.json and run migrate.
                //   both will break the application

                if (!deploySettings) throw new Error('No config available for database setup')
                // Setup and apply go through the worker API whenever there is a worker to call (the
                // internal/dev worker locally, the deployed worker remotely). The direct path
                // ($DatabaseNode over `wrangler d1 execute`, make-d1-binding.ts) can't run batches,
                // and apply always commits with one (setup does too on a fresh database), so it
                // can't apply migrations (issues/open/cli-direct-d1-batch-unsupported.md).
                // It is only attempted when no worker is reachable, so its error is the one reported.
                const useWorkerApi = c.isLocal || !!(deployRoute || await c.getApiRoute(true))

                // Setup DB: create metadata tables (_ddb_internal_kv, _db_migrations, _auth_identities)
                // todo handle database settings mismatch error from this endpoint. we need to first deploy the worker with the settings in the db and then apply migrations.
                try {
                    if (useWorkerApi) {
                        c.logger.debug('Setting up the database through the worker API')
                        const setupRequest: RequestInit = {method: 'POST', headers: {'Content-Type': 'application/json'}}
                        // A worker deployed seconds ago may not serve the new version (with its secrets) everywhere yet.
                        if (!c.isLocal && deployRoute) await fetchWorkerAfterDeploy(c, '/api/v1/setup-db', setupRequest, {serverErrors: rebindWorker})
                        else await fetchWorker(c, '/api/v1/setup-db', setupRequest, false)
                    } else {
                        c.logger.debug('No worker route available, setting up the database with direct D1 commands')
                        await c.getDb(deploySettings).setup()
                    }
                } catch (e: any) {
                    throw new Error(`Failed to set up database: ${getErrorMessage(e)}`)
                }

                c.logger.section?.('Applying migrations')
                c.logger.debug(`Syncing ${migrations.length} migrations, with ${newMigrations?.length || 0} new migrations`)
                // logger.info(migrations.map((m) => ` - ${m.name}`).join('\n'))

                try {
                    let applied: string[]
                    if (useWorkerApi) {
                        const applyRequest: RequestInit = {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({migrations, settings: deploySettings, lastVersion: lastVersion ?? null}),
                        }
                        // Still warming up after a fresh deploy: retry only answers that prove the worker didn't apply anything
                        const json = !c.isLocal && deployRoute
                            ? await fetchWorkerAfterDeploy(c, '/api/v1/migrations', applyRequest, {networkErrors: false, serverErrors: rebindWorker})
                            : await fetchWorker(c, '/api/v1/migrations', applyRequest, false)
                        applied = json.applied || []
                    } else {
                        applied = await c.getDb(deploySettings).migrationHelper.apply(migrations, deploySettings, lastVersion ?? null)
                    }

                    if (!applied?.length) {
                        if (newMigrations?.length) {
                            throw new Error(`Unable to apply ${newMigrations.length} new migrations`)
                        }
                        c.logger.warn('No migrations applied')
                    } else {
                        for (const m of applied) {
                            c.logger.success?.(m)
                        }
                        if (newMigrations?.length !== applied.length) {
                            // this should never happen actually since they are applied as batch
                            const unapplied = newMigrations?.filter(m => !applied.includes(m.name)) ?? []
                            c.logger.error(unapplied.map((m) => ` ❌ ${m.name}`).join('\n'))
                            throw new Error(`Unknown error - Only ${applied.length} of ${newMigrations?.length} new migrations applied`)
                        }
                    }
                    newSettingsSavedInDb = true
                }catch (e: any){
                    // const message = `Failed to apply migrations: ${e?.message??e}\n\nDo you want to deploy the worker anyway()?`
                    // const res = await prompts({
                    //     type: 'confirm',
                    //     name: 'value',
                    //     message: message,
                    //     initial: false,
                    // });
                    // if (!res.value)
                    throw e
                }

            }

            // ── Phase 3: Final deploy ──
            // If apply just ran, bundle `deploySettings` (matches the version apply committed).
            // Else (forceDeploy with no changes), bundle `lastConfig` — it came from KV and
            // already carries `version === lastVersion` since apply writes them atomically.
            if (hasNextConfig || newMigrations?.length || forceDeploy) {
                if (!c.isLocal) {
                    const config = newSettingsSavedInDb ? deploySettings : lastConfig
                    if(config) {
                        c.logger.section?.('Deploying')
                        try {
                            const finalRoute = await wranglerDeploy(c, config, !deployRoute)
                            // Post-deploy: ensure apiRoute is set in infra.jsonc
                            if (finalRoute || deployRoute) {
                                const reportedRoute = finalRoute || deployRoute
                                const existingApiRoute = await c.getApiRoute(true)
                                if (!existingApiRoute && reportedRoute) {
                                    // apiRoute not set yet — save the deploy route
                                    c.setApiRoute(reportedRoute!)
                                    c.logger.info(`Saved ${apiRouteKey}=${reportedRoute} to ${projectConfigFile}. Commit this file to version control.`)
                                } else if (existingApiRoute && reportedRoute && existingApiRoute !== reportedRoute) {
                                    c.logger.warn(`Deploy reported route ${reportedRoute} but ${projectConfigFile} has ${existingApiRoute}`)
                                }
                                if (!deployRoute) deployRoute = reportedRoute
                            }
                        } catch (e: any) {
                            // The migrations are applied but the worker still runs the previous code and
                            // config. Fail the command (non-zero exit) so scripts and CI see it; the
                            // database side is done, so re-running only has to redeploy the worker.
                            c.logger.warn('Migrations were applied, but the worker is still running the previous code and config.')
                            c.logger.warn('Fix the error, then run "teeny deploy --remote" again to redeploy the worker.')
                            throw new Error(`Final deploy failed: ${getErrorMessage(e)}`)
                        }
                    }else {
                        c.logger.error('No config to deploy, skipping wrangler deploy')
                    }
                } else {
                    // local worker is automatically deployed with new settings when next-config.json is written to config.json
                    if(hasNextConfig) {
                        // write the version-stamped settings that apply just committed to KV
                        localPersistDeploy(newSettingsSavedInDb ? deploySettings : lastConfig, c)
                    }
                }
            }
            if(hasNextConfig) {
                const nextConfigPath = path.join(c.migrationsPath, 'next-config.json')
                if(fs.existsSync(nextConfigPath)) {
                    c.logger.debug('Removing next-config.json')
                    fs.unlinkSync(nextConfigPath)
                }
            }

            c.logger.done?.('Migrations applied')
            if(deployRoute){
                c.logger.info(`\n+ Deployed: ${deployRoute}`)
                await printEndpointInfo(deployRoute, c.isLocal, c.logger)
            }
        }else {
            if(!c.isLocal)
                c.logger.info('No changes detected. Run with --deploy to deploy anyway.')
            c.logger.done?.('Up to date')
        }
    } finally {
        c.localWorkerSettings = undefined
    }
}
