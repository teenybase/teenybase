// Node's fetch() uses the system DNS resolver by default (dns.lookup → getaddrinfo).
// AUTO_DNS=1 overrides with Cloudflare/Google DNS — only for broken container DNS.
if (process.env.AUTO_DNS) await import('./utils/custom-dns.js')
import {cac} from 'cac'
import colors from 'picocolors'
import prompts from 'prompts'
import {createLogger, LogLevel, Logger, LogLevels} from './logger'
import * as fs from 'node:fs'
import path from 'path'
import {fileURLToPath} from 'node:url'
import {readableRelative, getErrorMessage} from './utils'
import {execSync, spawn} from 'node:child_process'
import {exportLocal} from './wrangler/d1/export'
import {loadConfigFromFile, loadWranglerConfigFromFile} from './config'
import {
    AUTO_CREATE,
    CliContext,
    deploySecrets,
    devVars,
    fetchDeployedMigrations,
    fetchWorker,
    applyTargetMode,
    deduplicateOptions,
    TargetMode,
    generateMigrationsDir,
    GlobalCLIOptions,
    loadLocalPersistConfig,
    migrateAndDeploy,
    parseWrangler,
    printEndpointInfo,
    prodVars,
    readSecretsFile
} from './cli-utils'
import {TEENYBASE_VERSION} from '../index'
import {
    applyManagedMode,
    authFlow,
    Credentials,
    DEFAULT_SERVER_URL,
    deleteCredentials,
    ensureEmailVerified,
    loadCredentials,
    managedFetch,
    NOT_LOGGED_IN_ERROR,
} from './credentials'
import {runInit, runCreate} from './init'
import {promptEmail, promptPassword} from './prompts'

process.env.WRANGLER_SEND_METRICS = 'false'
process.env.WRANGLER_HIDE_BANNER = 'true'
// Suppress wrangler info/warn noise by default. Restored to 'log' when --debug is used.
// Levels: none, error, warn, info, log, debug — https://github.com/cloudflare/workers-sdk/blob/3dce3881bdaf373aa9b2e52483e340ab8193151c/packages/wrangler/src/logger.ts#L10
process.env.WRANGLER_LOG = 'log' // todo log for now, change later

const cli = cac('teeny')
function findPackageRoot(): string {
    let dir = path.dirname(fileURLToPath(import.meta.url))
    while (dir !== path.dirname(dir)) {
        const pkgPath = path.join(dir, 'package.json')
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
            if (pkg.name === 'teenybase') return dir
        }
        dir = path.dirname(dir)
    }
    throw new Error('Could not find teenybase package root')
}
const __pkgRoot = findPackageRoot()

function readSkillSummary(content: string): string {
    const lines = content.split(/\r?\n/)
    let start = 0

    if (lines[0]?.trim() === '---') {
        start = 1
        while (start < lines.length && lines[start].trim() !== '---') start++
        if (start < lines.length) start++
    }

    for (let i = start; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line) continue
        return line.replace(/^#+\s*/, '')
    }

    return ''
}

function writeInfoToStderr(message: string, logLevel?: LogLevel) {
    if (LogLevels[logLevel || 'info'] >= LogLevels.info) {
        process.stderr.write(`${message}\n`)
    }
}

async function initContext(options: GlobalCLIOptions, logger: Logger) {
    const wranglerConfig = await parseWrangler(options.root, options, logger)
    const creds = options.remote
        ? await applyManagedMode(wranglerConfig?.config?.config?.account_id, logger)
        : null
    const c = new CliContext(options.root, options, wranglerConfig, logger, undefined, creds)
    return c
}

/**
 * Wraps a CLI command action with consistent error handling.
 * Creates a logger upfront and passes it to the action. On error, prints the
 * message via logger.error and the stack via logger.debug, then exits.
 * Actions that create a CliContext should assign it to `ctx.c` so cleanup runs on error.
 */
function wrapAction<TArgs extends any[]>(
    fn: (ctx: ActionContext, ...args: TArgs) => Promise<void>,
    target: TargetMode = 'both',
): (...args: TArgs) => Promise<void> {
    return async (...args: TArgs) => {
        // Last arg is always the options object from cac
        const options = args[args.length - 1] as GlobalCLIOptions
        deduplicateOptions(options)
        applyTargetMode(options, target)
        if (options.debug || options.logLevel === 'debug') {
            process.env.WRANGLER_LOG = 'log'
        }
        const logger = createLogger(options.debug ? 'debug' : options.logLevel)
        const ctx: ActionContext = {logger, c: undefined}
        try {
            await fn(ctx, ...args)
        } catch (e: any) {
            console.log() // spacing before error
            logger.error(colors.red(getErrorMessage(e)))
            logger.debug(e.stack?.replace(e.message || '', '').trim())
            await ctx.c?.stopLocal()
            process.exit(1)
        }
        await ctx.c?.stopLocal()
    }
}

interface ActionContext {
    logger: Logger
    c: CliContext | undefined
}

/**
 * Load credentials with optional wrangler config validation.
 * Tries to load wrangler config from the project root — if found and the account_id
 * is a tb- managed ID, calls applyManagedMode which validates that the logged-in user
 * matches the account_id (throws on mismatch). Falls back to loadCredentials() if no
 * wrangler config is present (e.g. running from outside a project directory).
 * Returns credentials + optional worker name from config.
 */
async function loadValidatedCredentials(options: GlobalCLIOptions, logger: Logger): Promise<{creds: Credentials, workerName: string | null}> {
    let workerName: string | null = null
    let creds: Credentials | null = null
    // Load wrangler config (optional — may not be in a project dir)
    let accountId: string | undefined
    try {
        const root = options.root || process.cwd()
        const wranglerConfig = await loadWranglerConfigFromFile(root, options.wrangler)
        workerName = wranglerConfig.config.name || null
        accountId = wranglerConfig.config.account_id
    } catch { /* no wrangler config — fine for platform-level commands */ }
    // applyManagedMode validates creds match account_id, sets env vars
    // Errors here (mismatch, network) must propagate — not swallowed
    if (accountId) {
        creds = await applyManagedMode(accountId, logger)
    }
    if (!creds) {
        creds = loadCredentials()
        if (!creds) throw new Error(NOT_LOGGED_IN_ERROR)

        const token = await ensureEmailVerified(creds.apiToken, creds, creds.serverUrl, logger)
        if (token !== creds.apiToken) creds = {...creds, apiToken: token}
    }
    process.env.TEENYBASE_SERVER_URL = creds.serverUrl
    if (!process.env.CLOUDFLARE_API_TOKEN) process.env.CLOUDFLARE_API_TOKEN = creds.apiToken
    return {creds, workerName}
}

cli
    .option('-c, --config <file>', `[string] use specified config file`)
    .option('-w, --wrangler <wrangler>', `[string] use specified wrangler config file`)
    .option('--db <db-name>', `[string] d1 database binding in wrangler (default: 'PRIMARY_DB')`)
    //     .option('--base <path>', `[string] public base path (default: /)`, {
    //         type: [convertBase],
    //     })
    .option('--local', `[boolean] use local database (default: true)`)
    .option('--remote', `[boolean] use remote database (default: false)`)
    .option('-l, --logLevel <level>', `[string] info | warn | error | silent`)
    .option('--clearScreen', `[boolean] allow/disable clear screen when logging`)
    .option('-d, --debug [feat]', `[string | boolean] show debug logs`)
    .option('-f, --filter <filter>', `[string] filter debug logs`)
    .option('--root <root>', `[string] project root (default: cwd)`)
// .option('-m, --mode <mode>', `[string] set env mode`)

// generate
cli
    .command('generate', 'generate migrations')
    .option(
        '--clean',
        `[boolean] delete migrations folder and download latest from deployment before generating (default: true)`,
    )
    .action(wrapAction(
        async (
            ctx,
            options: GlobalCLIOptions & { clean: boolean },
        ) => {
            ctx.c = await initContext(options, ctx.logger)
            await generateMigrationsDir(ctx.c, Boolean(options.clean??true))
        },
    ))

async function doMigrateAndDeploy(options: GlobalCLIOptions & {
    clean?: boolean;
    deploy?: boolean;
    migrate?: boolean
}, c: CliContext) {
    const forceDeploy = Boolean(options.deploy ?? true)
    const doMigrate = Boolean(options.migrate ?? true)
    const clean = Boolean(options.clean ?? true)
    const skipConfirm = Boolean(options.y || options.yes)
    await migrateAndDeploy(c, clean, doMigrate, forceDeploy, skipConfirm)
}

// deploy worker and apply migrations
cli
    .command('deploy', 'deploy worker and apply migrations')
    .option(
        '--deploy',
        `[boolean] deploy the worker even if there are no teenybase config changes (default: true)`,
    )
    .option(
        '--migrate',
        `[boolean] apply new migrations. If disabled, this will throw an error if there are new/unapplied migrations (default: true)`,
    )
    .option(
        '--clean',
        `[boolean] delete migrations folder and download latest from deployment before generating (default: true)`,
    )
    .option(
        '-y, --yes',
        `[boolean] skip confirmation prompts (default: false)`,
    )
    .action(wrapAction(
        async (
            ctx,
            options: GlobalCLIOptions & { clean?: boolean, deploy?: boolean, migrate?: boolean },
        ) => {
            ctx.c = await initContext(options, ctx.logger)
            await doMigrateAndDeploy(options, ctx.c)
        },
    ))

// deprecated alias for deploy
cli
    .command('migrate', 'deprecated: use "deploy" instead')
    .option('--deploy', `[boolean] (default: true)`)
    .option('--migrate', `[boolean] (default: true)`)
    .option('--clean', `[boolean] (default: true)`)
    .option('-y, --yes', `[boolean] skip confirmation prompts (default: false)`)
    .action(wrapAction(
        async (
            ctx,
            options: GlobalCLIOptions & { clean?: boolean, deploy?: boolean, migrate?: boolean },
        ) => {
            ctx.c = await initContext(options, ctx.logger)
            ctx.logger.warn('"teeny migrate" is deprecated. Use "teeny deploy" instead.')
            await doMigrateAndDeploy(options, ctx.c)
        },
    ))


// deploy secrets
cli
    .command('secrets', 'list or upload secrets to the deployed worker')
    .option(
        '--upload',
        `[boolean] upload secrets from .prod.vars to the worker (default: false)`,
    )
    .option(
        '-y, --yes',
        `[boolean] skip confirmation prompt (default: false)`,
    )
    .action(wrapAction(
        async (
            ctx,
            options: GlobalCLIOptions & { upload?: boolean, yes?: boolean },
        ) => {
            ctx.c = await initContext(options, ctx.logger)
            const c = ctx.c

            const doUpload = Boolean(options.upload??false)
            const envRes = readSecretsFile(c, false) as { adminToken?: string, secrets?: Record<string, string> }
            const secretKeys = [...Object.keys(envRes.secrets??{})]
            if(secretKeys.length) {
                c.logger.info(`${secretKeys.length} values found in ${c.isLocal ? devVars : prodVars}`)
                secretKeys.forEach((k) => {
                    c.logger.info(` - ${k}`)
                })
                c.logger.info('')
            }
            if(!doUpload){
                c.logger.warn('Run with --upload to deploy secrets to the worker')
                return
            }
            if(c.isLocal){
                c.logger.error('No need to deploy secrets in local development, they are automatically read by the dev server')
                return
            }

            const workerName = c.wranglerConfig.config.config.name
            const cfAccountId = c.wranglerConfig.config.config.account_id || process.env.CLOUDFLARE_ACCOUNT_ID
            if (!workerName) {
                throw new Error('Required - No worker name(name) found in wrangler config')
            }
            if (!cfAccountId) {
                throw new Error('Required - No cloudflare account id(cfAccountId) found in wrangler config or CLOUDFLARE_ACCOUNT_ID env variable')
            }

            // todo check if cloudflare/teeny login or throw error/show warning/trigger login
            if (!options.yes) {
                const message = `About to upload(create/replace) ${secretKeys.length} secrets to the worker ${workerName} in cloudflare account ${cfAccountId}.\n Do you want to continue? `
                const res = await prompts({
                    type: 'confirm',
                    name: 'value',
                    message: message,
                    initial: true,
                });
                if (!res.value) {
                    throw new Error('Secrets upload cancelled by user')
                }
            }

            await deploySecrets(c, envRes.secrets)
        },
    ))

// dev
cli
    .command('dev', 'start wrangler dev server')
    .action(wrapAction(
        async (
            ctx,
            options: GlobalCLIOptions & { clean: boolean, generate: boolean },
        ) => {
            ctx.c = await initContext(options, ctx.logger)
            const c = ctx.c

            const config = loadLocalPersistConfig(c)
            if(!config){
                throw new Error(`No local persist config found. Please run "teeny deploy --local" first to generate the config and migrations for the local database.`)
            }

            // this check is for first time when .local-persist/config.json also doesn't exist
            // const configPath = path.join(c.migrationsPath, 'config.json')
            // if(!fs.existsSync(c.migrationsPath) || !fs.existsSync(configPath)){
            //     throw new Error(`Migrations or Config file not found. First run "teeny deploy ${c.isLocal ? '--local':'--remote'}" to generate and apply migrations to the ${c.isLocal ? 'local':'remote'}" database.`)
            //     process.exit(1)
            // }

            const tsconfigPath = c.createCustomTsconfigForWorker(config, 'dev')
            // ${c.isLocal ? '--local' : '--remote'} \ // todo isLocal is diff than --local and --remote for dev command, here remote means whether to use remote database and preview or not, check wrangler docs on latest on this, it keeps changing
            const wranglerArgs = [
                'wrangler', 'dev',
                `--config=${c.wranglerConfig.config.path}`,
                `--persist-to=${c.localPersistPath}`,
                `--port=${c.devServerPort}`,
                `--tsconfig=${tsconfigPath}`,
            ]
            // Allow overriding the workerd inspector port (default 9229) to run multiple dev servers
            if (process.env.TEENY_INSPECTOR_PORT) {
                wranglerArgs.push(`--inspector-port=${process.env.TEENY_INSPECTOR_PORT}`)
            }
            const devUrl = `http://localhost:${c.devServerPort}`
            await printEndpointInfo(devUrl, true, c.logger)
            c.logger.info('')

            const child = spawn('npx', wranglerArgs, {cwd: c.root, stdio: 'inherit', shell: true})

            const doCleanup = () => {
                c.removeCustomTsconfig('dev')
            }

            // Relay signals to child so it shuts down gracefully,
            // and register exit handler to ensure temp tsconfig is always cleaned up
            const onSignal = (signal: NodeJS.Signals) => {
                child.kill(signal)
            }
            process.on('SIGINT', onSignal)
            process.on('SIGTERM', onSignal)
            process.on('exit', doCleanup)

            await new Promise<void>((resolve) => {
                child.on('close', (code) => {
                    process.removeListener('SIGINT', onSignal)
                    process.removeListener('SIGTERM', onSignal)
                    process.removeListener('exit', doCleanup)
                    doCleanup()
                    if (code && code !== 0) {
                        process.exit(code)
                    }
                    resolve()
                })
            })
        },
        'local',
    ))

// backup
cli
    .command('backup', 'backup database and schema')
    .action(wrapAction(
        async (
            ctx,
            options: GlobalCLIOptions,
        ) => {
            ctx.c = await initContext(options, ctx.logger)
            const c = ctx.c

            if(!options.local && c.wranglerConfig.db.database_id.startsWith(AUTO_CREATE)) {
                c.logger.error(`Database ${c.wranglerConfig.db.binding} has not been created yet. Run \`teeny deploy --remote\` first.`)
                return
            }
            const dir = `db_backups/${options.local?'local':'remote'}/${c.wranglerConfig.db.binding}/${new Date().toISOString()}`
            const absDir = path.join(c.root, dir)
            fs.mkdirSync(absDir, {recursive: true})

            let dbSettings
            try {
                dbSettings = (await loadConfigFromFile(c.root, options.config, options.logLevel)).config
            } catch (e) {
                c.logger.debug(`Could not load config: ${(e as Error).message}. Using defaults for backup.`)
                dbSettings = {tables: [], jwtSecret: '', appUrl: ''} as any
            }
            const migrations = await fetchDeployedMigrations(c, dbSettings)
            if(migrations.settings)
                fs.writeFileSync(path.join(absDir, 'config.json'), JSON.stringify(migrations.settings, null, 2))

            // this is not really required since the database backup will also export the migrations table
            if(migrations.migrations.length) {
                const historyDir = path.join(absDir, 'history')
                fs.mkdirSync(historyDir, {recursive: true})
                for (const m of migrations.migrations) {
                    fs.writeFileSync(path.join(historyDir, m.name), m.sql)
                }
            }

            // Check for FTS5 virtual tables — wrangler d1 export cannot handle them.
            // Remote export is especially dangerous: it locks the database for hours (cloudflare/workers-sdk#9519).
            const hasFts = migrations.settings?.tables?.some((t: any) => t.fullTextSearch)
            if (hasFts) {
                const ftsTableNames = migrations.settings!.tables.filter((t: any) => t.fullTextSearch).map((t: any) => t.name)
                if (!options.local) {
                    // BLOCK remote export — it will brick the database
                    throw new Error(
                        `Cannot export: database has full-text search (FTS5) virtual tables on: ${ftsTableNames.join(', ')}.\n` +
                        `Remote D1 export with FTS5 tables will lock the database and make it inaccessible for hours (cloudflare/workers-sdk#9519).\n` +
                        `Workaround: remove FTS from the config, migrate to drop the virtual tables, export, then re-add FTS and migrate again.`
                    )
                } else {
                    c.logger.warn(`Database has FTS5 virtual tables on: ${ftsTableNames.join(', ')}. Local export may fail.`)
                    c.logger.info('  Config and migration history have been saved. Attempting SQL export...')
                }
            }

            try {
                if(options.local){
                    // this is required since wrangler doesn't support persist-to for export command
                    await exportLocal(c.wranglerConfig.config.config, c.wranglerConfig.db.binding, path.join(absDir, 'schema.sql'), [], false, true, c.localPersistPath, c.logger)
                    await exportLocal(c.wranglerConfig.config.config, c.wranglerConfig.db.binding, path.join(absDir, 'data.sql'), [], true, false, c.localPersistPath, c.logger)
                }else {
                    const command = `npx wrangler d1 export ${c.wranglerConfigFlag} ${c.wranglerConfig.db.binding} --remote --no-data --output ${JSON.stringify(path.join(absDir, 'schema.sql'))}`
                    const command2 = `npx wrangler d1 export ${c.wranglerConfigFlag} ${c.wranglerConfig.db.binding} --remote --no-schema --output ${JSON.stringify(path.join(absDir, 'data.sql'))}`
                    // todo switch to spawn so process can be interrupted cleanly
                    execSync(command, {cwd: c.root, stdio: 'inherit'})
                    execSync(command2, {cwd: c.root, stdio: 'inherit'})
                }
            } catch (e: any) {
                // Rewrite FTS5 export error with a friendlier message
                if (/cannot export databases with Virtual Tables/i.test(e.message || '')) {
                    throw new Error(
                        `SQL export failed: local D1 export does not support FTS5 virtual tables.\n` +
                        `Config and migration history were saved successfully.\n` +
                        `For the full database, copy the .sqlite file directly from ${readableRelative(c.localPersistPath)}/`
                    )
                }
                throw e
            }
        },
    ))

// build
cli
    .command('build', 'build for production')
    .option('--outDir <dir>', `[string] output directory (default: dist)`)
//     .option(
//         '--sourcemap [output]',
//         `[boolean | "inline" | "hidden"] output source maps for build (default: false)`,
//     )
//     .option(
//         '--minify [minifier]',
//         `[boolean | "terser" | "esbuild"] enable/disable minification, ` +
//         `or specify minifier to use (default: esbuild)`,
//     )
//     .option('-w, --watch', `[boolean] rebuilds when modules have changed on disk`)
    .action(wrapAction(
        async (
            ctx,
            options: GlobalCLIOptions & { outDir?: string },
        ) => {
            ctx.c = await initContext(options, ctx.logger)
            const c = ctx.c

            const {nextConfig, lastConfig} = await generateMigrationsDir(c, false, false)

            c.logger.info('Starting Build')

            if(!fs.existsSync(c.migrationsPath)) fs.mkdirSync(c.migrationsPath, {recursive: true})
            const config = nextConfig || lastConfig
            if(!config){
                throw new Error(`No config found to build. Please run "teeny deploy ${c.isLocal ? '--local' : '--remote'}" first to generate the config and migrations for the database.`)
            }
            const outDir = options.outDir || path.join(c.root, 'dist')
            const res = c.buildLocal(config, outDir, true, true, false, '--minify')
            if(res) c.logger.info(`Finished Build. Written to "${readableRelative(outDir)}"`)
        },
    ))

// exec
cli
    .command('exec <route>', 'execute a route on the worker with admin token')
    .option('-m, --method <method>', `[string] http method (default: GET)`)
    .option('-d, -b, --data, --body <body>', `[string] http body`)
    .option('-y, --yes', `[boolean] skip confirmation. only for non-GET requests (default: false)`)
    .option('-r, --raw', `[boolean] output raw response (default: false)`)
    .option('--explain', `[boolean] dry run and return the queries that will be executed (default: false)`)
    .action(wrapAction(
        async (
            ctx,
            route: string,
            options: GlobalCLIOptions & { method?: string, body?: string, yes?: boolean, raw?: boolean, explain?: boolean },
        ) => {
            ctx.c = await initContext(options, ctx.logger)
            const c = ctx.c

            if(!options.yes && options.method && options.method?.toUpperCase() !== 'GET'){
                const res = await prompts({
                    type: 'confirm',
                    name: 'value',
                    message: `Requesting "${route}" on the worker. This might change the database state.\nAre you sure you want to continue?`,
                    initial: true,
                });
                if (!res.value) {
                    throw new Error('Execution cancelled by user')
                }
            }

            const routePath = path.join(
                !options.explain ? '/api/v1/table/' : '/api/v1/explain/table/',
                route)
            const method = (options.method || 'GET').toUpperCase()
            c.logger.info(`${colors.dim(method)} ${route}`)
            const body = options.body || (options as any).data || (options as any).d || (options as any).b
            const res = await fetchWorker(c, routePath, {
                method,
                body,
                headers: {
                    'Content-Type': 'application/json',
                }
            }, false, !options.raw)
            if(!options.raw) {
                console.log(typeof res === 'string' ? res : JSON.stringify(res, null, 2))
            }else {
                console.log(res)
            }
        },
    ))

// register
cli
    .command('register', 'create a Teenybase account')
    .option('--server <url>', `[string] server URL (default: ${DEFAULT_SERVER_URL})`)
    .option('--email <email>', `[string] email address`)
    .option('--username <username>', `[string] username (default: derived from email)`)
    .option('--password <password>', `[string] password (min 8 characters)`)
    .action(wrapAction(
        async (ctx, options: GlobalCLIOptions & { server?: string, email?: string, username?: string, password?: string }) => {
            const serverUrl = options.server?.replace(/\/+$/, '') || process.env.TEENYBASE_URL?.replace(/\/+$/, '') || DEFAULT_SERVER_URL
            const emailVal = await promptEmail(options.email)
            const defaultUsername = emailVal.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '_')
            let usernameVal: string = options.username || ''
            if (!usernameVal) {
                const res = await prompts({
                    type: 'text', name: 'value', message: 'Username:',
                    initial: defaultUsername,
                    validate: (v: string) => v.length >= 1 || 'Username is required',
                })
                if (!res.value) throw new Error('Username is required. Pass --username or run in an interactive terminal.')
                usernameVal = res.value
            }
            const passVal = await promptPassword(options.password, {confirm: true, minLength: 8})
            await authFlow({
                serverUrl, logger: ctx.logger, username: usernameVal,
                authPath: '/api/v1/table/platform_users/auth/sign-up',
                authBody: {email: emailVal, username: usernameVal, name: usernameVal, password: passVal, passwordConfirm: passVal},
                actionLabel: 'Registered as',
                interactive: !!process.stdin.isTTY && !(options.email && options.password),
            })
        },
        'none',
    ))

// login
cli
    .command('login', 'log in to Teenybase')
    .option('--server <url>', `[string] server URL (default: ${DEFAULT_SERVER_URL})`)
    .option('--email <email>', `[string] email address`)
    .option('--password <password>', `[string] password`)
    .action(wrapAction(
        async (ctx, options: GlobalCLIOptions & { server?: string, email?: string, password?: string }) => {
            const serverUrl = options.server?.replace(/\/+$/, '') || process.env.TEENYBASE_URL?.replace(/\/+$/, '') || DEFAULT_SERVER_URL
            const emailVal = await promptEmail(options.email)
            const passVal = await promptPassword(options.password)
            await authFlow({
                serverUrl, logger: ctx.logger,
                authPath: '/api/v1/table/platform_users/auth/login-password',
                authBody: {email: emailVal, password: passVal},
                actionLabel: 'Logged in as',
                interactive: !!process.stdin.isTTY && !(options.email && options.password),
            })
        },
        'none',
    ))

// logout
cli
    .command('logout', 'log out from Teenybase')
    .action(wrapAction(
        async (ctx, options: GlobalCLIOptions) => {
            if (deleteCredentials()) {
                ctx.logger.info('Logged out successfully')
            } else {
                ctx.logger.info('Not logged in')
            }
        },
        'none',
    ))

// whoami
cli
    .command('whoami', 'show current logged-in user')
    .action(wrapAction(
        async (ctx, options: GlobalCLIOptions) => {
            const {logger} = ctx
            const creds = loadCredentials()
            if (creds) {
                logger.info(`Logged in as ${colors.bold(creds.email)}`)
                logger.info(`Server: ${creds.serverUrl}`)
            } else {
                logger.info('Not logged in. Run "teeny register" or "teeny login" to get started.')
            }
        },
        'none',
    ))

// list
cli
    .command('list', 'list deployed workers')
    .action(wrapAction(
        async (ctx, options: GlobalCLIOptions) => {
            const {logger} = ctx
            await loadValidatedCredentials(options, logger)

            const data = await managedFetch('/client/v4/managed/workers', {
                signal: AbortSignal.timeout(15000),
            })

            const workers = data.result || []
            if (workers.length === 0) {
                logger.info('No workers deployed. Run `teeny deploy` to deploy.')
                return
            }

            logger.info(colors.bold('Your workers:\n'))
            for (const w of workers) {
                logger.info(`  ${colors.green(w.name)}`)
                logger.info(`    Created: ${w.created_at}`)
                if (w.databases?.length > 0) {
                    logger.info(`    Databases: ${w.databases.map((d: any) => d.name).join(', ')}`)
                }
                logger.info('')
            }
        },
        'remote',
    ))

// status
cli
    .command('status [name]', 'show status of a deployed worker')
    .action(wrapAction(
        async (ctx, name: string | undefined, options: GlobalCLIOptions) => {
            const {logger} = ctx
            const {creds, workerName: workerNameFromConfig} = await loadValidatedCredentials(options, logger)

            const workerName = name || workerNameFromConfig
            if (!workerName) {
                throw new Error('Worker name required. Provide as argument or run from a project with wrangler.jsonc.')
            }

            const data = await managedFetch(`/client/v4/managed/workers/${encodeURIComponent(workerName)}`, {
                signal: AbortSignal.timeout(15000),
            })

            const w = data.result
            logger.info(colors.bold(`Worker: ${w.name}\n`))
            // Show gateway URL if available, otherwise fall back to raw CF URL
            if (creds.gatewayDomain && creds.username) {
                const gwUrl = creds.gatewayDomain.includes('/')
                    ? `https://${creds.gatewayDomain}/${creds.username}/${w.name}`
                    : `https://${w.name}--${creds.username}.${creds.gatewayDomain}`
                logger.info(`  URL: ${gwUrl}`)
            } else if (w.url) {
                logger.info(`  URL: ${w.url}`)
            }
            logger.info(`  Created: ${w.created_at}`)
            if (w.deployment) {
                logger.info(`  Last deploy: ${w.deployment.created_on}`)
            }
            if (w.databases?.length > 0) {
                logger.info(`  Databases:`)
                for (const d of w.databases) {
                    logger.info(`    - ${d.name}`)
                }
            }
        },
        'remote',
    ))

// todo this should make a list of all the resources used in the current project, and prompt to delete all of them or ask one by one. when deleted the resource reference should be removed from wrangler.json and replaced with TEENY_AUTO_CREATE:region:name
// delete
cli
    .command('delete [name]', 'delete a deployed worker and its databases')
    .option('-y, --yes', `[boolean] skip confirmation prompt (default: false)`)
    .action(wrapAction(
        async (ctx, name: string | undefined, options: GlobalCLIOptions & { yes?: boolean }) => {
            const {logger} = ctx
            const {workerName: workerNameFromConfig} = await loadValidatedCredentials(options, logger)

            const workerName = name || workerNameFromConfig
            if (!workerName) {
                throw new Error('Worker name required. Provide as argument or run from a project with wrangler.jsonc.')
            }

            // First fetch status to show what will be deleted
            const workerPath = `/client/v4/managed/workers/${encodeURIComponent(workerName)}`
            const statusData = await managedFetch(workerPath, {
                signal: AbortSignal.timeout(15000),
            })

            const w = statusData.result
            logger.info(colors.yellow(`About to delete worker "${w.name}"`))
            if (w.databases?.length > 0) {
                logger.info(colors.yellow(`  This will also delete databases: ${w.databases.map((d: any) => d.name).join(', ')}`))
            }

            if (!options.yes) {
                const res = await prompts({
                    type: 'confirm',
                    name: 'value',
                    message: 'Are you sure you want to delete this worker and all its data?',
                    initial: false,
                })
                if (!res.value) {
                    logger.info('Deletion cancelled.')
                    return
                }
            }

            const deleteData = await managedFetch(workerPath, {
                method: 'DELETE',
                signal: AbortSignal.timeout(30000),
            })

            const deleted = deleteData.result?.deleted
            logger.info(colors.green(`Deleted worker: ${deleted?.workers?.join(', ') || workerName}`))
            if (deleted?.databases?.length > 0) {
                logger.info(colors.green(`Deleted databases: ${deleted.databases.join(', ')}`))
            }
        },
        'remote',
    ))

// logs
cli
    .command('logs [name]', 'stream logs from a deployed worker')
    .option('--json', '[boolean] output raw JSON per event')
    .option('--since <duration>', '[string] how far back to start (e.g. 30s, 5m, 1h)', {default: '5m'})
    .option('--interval <duration>', '[string] polling interval (default: 8s)')
    .option('--overlap <duration>', '[string] overlap window to catch delayed events (default: 1m)')
    .option('--limit <n>', '[number] stop after N events (for CI/scripting)')
    .action(wrapAction(
        async (ctx, name: string | undefined, options: GlobalCLIOptions & {json?: boolean, since?: string, interval?: string, overlap?: string, limit?: string}) => {
            ctx.c = await initContext(options, ctx.logger)
            const {runLogs} = await import('./logs.js')
            await runLogs(ctx.c, name, options)
        },
        'remote',
    ))

// init
cli
    .command('init', 'initialize teenybase in the current directory')
    .option('-t, --template <template>', `[string] project template (with-auth, blank)`)
    .option('-y, --yes', `[boolean] skip prompts and use defaults (default: false)`)
    .action(wrapAction(
        async (
            ctx,
            options: GlobalCLIOptions & {template?: string},
        ) => {
            const root = options.root || process.cwd()
            await runInit(root, {yes: Boolean(options.yes || options.y), template: options.template})
        },
        'none',
    ))

// create
cli
    .command('create <name>', 'create a new teenybase project')
    .option('-t, --template <template>', `[string] project template (with-auth, blank)`)
    .option('-y, --yes', `[boolean] skip prompts and use defaults (default: false)`)
    .action(wrapAction(
        async (
            ctx,
            name: string,
            options: GlobalCLIOptions & {template?: string},
        ) => {
            await runCreate(name, {yes: Boolean(options.yes || options.y), template: options.template})
        },
        'none',
    ))

// docs
cli
    .command('docs', 'read docs if you\'re new to Teenybase')
    .action(wrapAction(
        async (ctx) => {
            const docsDir = path.join(__pkgRoot, 'docs')
            if (!fs.existsSync(docsDir) || !fs.statSync(docsDir).isDirectory()) {
                throw new Error(`docs/ directory not found in installed package at ${docsDir}`)
            }

            const files = fs.readdirSync(docsDir)
                .filter(file => file.endsWith('.md'))
                .sort()

            console.log(colors.bold(colors.cyan('Documentation files:\n')))
            console.log(`  ${colors.dim(docsDir)}\n`)
            for (const file of files) {
                const sizeKb = (fs.statSync(path.join(docsDir, file)).size / 1024).toFixed(1)
                console.log(`  ${colors.green(file)}  ${colors.dim(`${sizeKb} KB`)}`)
            }
        },
        'none',
    ))

// skills
cli
    .command('skills', 'check available Teeny skills before doing complex workflows')
    .action(wrapAction(
        async (ctx) => {
            const skillsDir = path.join(__pkgRoot, 'skills')
            if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) {
                throw new Error(`skills/ directory not found in installed package at ${skillsDir}`)
            }

            const skills = fs.readdirSync(skillsDir, {withFileTypes: true})
                .filter(entry => entry.isDirectory())
                .map(entry => {
                    const directory = path.join(skillsDir, entry.name)
                    const skillMd = path.join(directory, 'SKILL.md')
                    const description = fs.existsSync(skillMd)
                        ? readSkillSummary(fs.readFileSync(skillMd, 'utf-8'))
                        : ''
                    return {name: entry.name, description, directory}
                })
                .sort((a, b) => a.name.localeCompare(b.name))

            console.log(colors.bold(colors.cyan('Available skills:\n')))
            for (const skill of skills) {
                console.log(`  ${colors.green(skill.name)}`)
                if (skill.description) console.log(`    ${skill.description}`)
                console.log(`    ${colors.dim(skill.directory)}`)
                console.log()
            }
        },
        'none',
    ))

// inspect
cli
    .command('inspect', 'dump resolved DatabaseSettings as JSON')
    .option('--table <name>', '[string] filter to a single table')
    .option('--validate', '[boolean] run Zod validation on the config')
    .action(wrapAction(
        async (ctx, options: GlobalCLIOptions & {table?: string, validate?: boolean}) => {
            const root = options.root || process.cwd()
            let config: any
            try {
                config = (await loadConfigFromFile(root, options.config, options.logLevel)).config
            } catch (e) {
                throw new Error(`Failed to load config: ${getErrorMessage(e)}`)
            }

            if (options.validate) {
                const {databaseSettingsSchema} = await import('../types/zod/databaseSettingsSchema')
                const {formatZodError} = await import('../utils/zod')
                const result = databaseSettingsSchema.safeParse(config)
                if (!result.success) {
                    throw new Error(formatZodError(result.error, 'Config validation failed'))
                }
                writeInfoToStderr(colors.green('Config is valid'), ctx.logger.level)
            }

            const output = options.table
                ? (config.tables || []).find((table: any) => table.name === options.table)
                : config

            if (options.table && !output) {
                const available = (config.tables || []).map((table: any) => table.name).join(', ') || 'none'
                throw new Error(`Table "${options.table}" not found. Available: ${available}`)
            }

            console.log(JSON.stringify(output, null, 2))
        },
        'none',
    ))

cli.help((sections) => {
    for (const s of sections) {
        if (s.title) s.title = colors.bold(colors.cyan(s.title))
        if (s.body) s.body = s.body.replace(/^  ([\w-]+(?:[\s|,]+[\w-<>\[\].]+)*)/gm, (_, m) => '  ' + colors.green(m))
    }
    return sections
})

cli.command('[...args]', '')
    .action(() => {
        cli.outputHelp()
    })

cli.version(TEENYBASE_VERSION)

// Global error handler — last resort for truly unhandled errors.
// All commands use wrapAction so this should rarely fire.
function handleFatalError(e: any) {
    const isDebug = process.argv.some(a => a === '--debug' || a === '-d')
    const logger = createLogger(isDebug ? 'debug' : 'info')
    logger.error(getErrorMessage(e))
    logger.debug(e?.stack?.replace(e?.message || '', '').trim())
    process.exit(1)
}
process.on('uncaughtException', handleFatalError)
process.on('unhandledRejection', handleFatalError)

cli.parse()
