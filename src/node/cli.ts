// import { performance } from 'perf_hooks'
import {cac} from 'cac'
import colors from 'picocolors'
import prompts from 'prompts'
import {VERSION} from './constants'
import {loadConfigFromFile, loadWranglerConfigFromFile} from './config'
import {createLogger, Logger, LogLevel} from './logger'
import * as fs from 'node:fs'
import path from 'path'
import {escapeRegExp, normalizePath, readableRelative} from './utils'
import {unstable_dev, Unstable_DevOptions, Unstable_DevWorker} from 'wrangler'
import {DatabaseSettings, databaseSettingsSchema} from '../types/config'
import {execSync} from 'node:child_process'
import dotenv from 'dotenv'
import {URL} from 'url'
import {exportLocal} from './wrangler/export'
import {generateMigrations} from '../sql/schema/generateMigrations'

const adminTokenKey = 'ADMIN_SERVICE_TOKEN'
const apiRouteKey = 'API_ROUTE'
const devVars = '.dev.vars'
const prodVars = '.prod.vars'

// // global options
interface GlobalCLIOptions {
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
    clearScreen?: boolean
    d?: boolean | string
    debug?: boolean | string
    f?: string
    filter?: string
    // m?: string
    // mode?: string
    // force?: boolean
    // w?: boolean
}

const filterDuplicateOptions = <T extends object>(options: GlobalCLIOptions&T) => {
    if(options.local === options.remote) {
        throw new Error('Use either --local or --remote')
    }
    for (const [key, value] of Object.entries(options)) {
        if (Array.isArray(value)) {
            options[key as keyof T] = value[value.length - 1]
        }
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

declare type RequestInfo = string | URL | Request
class CliContext{
    localWorker: Unstable_DevWorker|undefined
    readonly migrationsPath: string
    get isLocal(){
        return !this.options.remote
    }
    public root: string
    public logger: Logger
    public devServerLogLevel: Unstable_DevOptions['logLevel']
    constructor(root: string|undefined, public options: GlobalCLIOptions, public wranglerConfig: WranglerConfigRet, devServerLogLevel: Unstable_DevOptions['logLevel'] = "none") {
        this.logger = createLogger(options.logLevel)
        this.root = normalizePath(root ? path.resolve(root) : process.cwd())
        this.migrationsPath = path.join(this.root, wranglerConfig.migrations)
        this.devServerLogLevel = devServerLogLevel
    }

    get localPersistPath(){
        const persistPath = path.join(this.root, localPersist)
        return persistPath
    }

    buildLocal(outDir?: string, log = true, doThrow = true, clean = false): boolean{
        const _outDir = outDir ?
            // explicit path is always resolved from cwd
            path.resolve(outDir) :
            path.join(this.root, '.teeny', 'tmp', 'dist-worker')
        const lastWLogEnv = process.env.WRANGLER_LOG
        process.env.WRANGLER_LOG = log ? 'info' : 'error'
        try {
            const command = `npx wrangler deploy --dry-run --outdir=${JSON.stringify(_outDir)}`
            execSync(command, {cwd: this.root, stdio: ['inherit', 'pipe', 'pipe']})
            return true
        }catch (e: any) {
            const err = ''+ e.stderr
            const isBuildError = err.match(/Build failed with (\d+) errors:/g)
            const migrationsDir = readableRelative(this.migrationsPath)
            const configFile = path.join(migrationsDir, 'config.json') // = ./migrations/config.json
            if(isBuildError?.length){
                //   ✘ [ERROR] Could not resolve "./migrations/config.json"
                // const configNotFound = !!err.match(/✘ \[ERROR\] Could not resolve "(.*)"/gm).find((m: string) => m === (configFile))
                const configNotFound = !!err.match(new RegExp(`Could not resolve "${escapeRegExp(readableRelative(configFile))}"`, 'gm'))?.length
                if(configNotFound){
                    this.logger.error(`✘ [ERROR] Unable to build the worker - config.json not found in migrations folder. Run teeny generate or teeny migrate to generate migrations and corresponding config.json.`)
                }
                //   ✘ [ERROR] Unexpected "a" in JSON
                //
                //       migrations/config.json:176:10:
                const isConfigError = !!err.match(new RegExp(`${escapeRegExp(configFile)}:\\d+:\\d+:`, 'g'))?.length
                if(isConfigError){
                    this.logger.error(`✘ [ERROR] Unable to build the worker - config.json is not valid. Run teeny generate or teeny migrate to generate migrations and corresponding config.json.`)
                    // if(doThrow) throw e
                    // return 1
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
        }
    }

    private _startingPromise: Promise<Unstable_DevWorker>|undefined
    async startLocal(){
        if(this.localWorker) return this.localWorker
        if(this._startingPromise) return await this._startingPromise
        const built = this.buildLocal(undefined, false, false, true)
        if(!built){
            throw new Error('Unable to build and connect to local worker. Run "teeny dev --local" to check the errors.')
        }

        if(this.options.local) this.logger.debug('Local worker starting')
        this._startingPromise = this.options.local ? unstable_dev(this.wranglerConfig.config.main, {
            moduleRoot: this.root,
            // config: wranglerConfig.config,
            local: true,
            bundle: true,
            persistTo: this.localPersistPath,
            logLevel: this.devServerLogLevel, //"none",
            // logLevel: "info",
            experimental: {
                disableExperimentalWarning: true,
            }
        }) : undefined
        this.localWorker = await this._startingPromise
        if(this.localWorker) this.logger.debug('Local worker started')
        return this.localWorker
    }
    async localFetch(input?: RequestInfo, init?: RequestInit): Promise<Response>{
        const w = await this.startLocal()
        if(!w) throw new Error('Unable to start local worker')
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
    }
}

function readMigrationsFolder(migrationsFolderPath: string) {
    // logger.info(`Reading Migrations folder: ${migrationsFolderPath}`)

    if (!fs.existsSync(migrationsFolderPath)) {
        fs.mkdirSync(migrationsFolderPath)
    }
    const fileNames = fs
        .readdirSync(migrationsFolderPath)
    let sqlNames = fileNames
        .filter((name) => name.endsWith(".sql"));
    let configFile = fileNames.find((name) => name === 'config.json')
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
    const configPath = configFile ? path.join(migrationsFolderPath, configFile) : null
    const nextConfigPath = nextConfigFile ? path.join(migrationsFolderPath, nextConfigFile) : null
    try {
        currentConfig = configPath ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : undefined
    }catch (e: any) {
        throw new Error(`Unable to read file ${readableRelative(configPath||'')}\n${e?.message || e}\n\nThis file is not supposed to be manually edited. You may revert any changes, or delete the "${readableRelative(migrationsFolderPath)}" and "${readableRelative(localPersist)}" directory and run again.`)
    }
    try {
        nextConfig = nextConfigPath ? JSON.parse(fs.readFileSync(nextConfigPath, 'utf8')) : undefined
    } catch (e: any) {
        throw new Error(`Unable to read file ${readableRelative(nextConfigPath||'')}\n${e?.message || e}\n\nThis file is not supposed to be manually edited. You may try deleting the file and run again`)
    }
    return {migrations: currentMigrations, config: currentConfig, nextConfig}
}

type WranglerConfigRet = {
    config: any
    db: { binding: string, migrations_dir: string }
    migrations: string
}
async function parseWrangler(root: string|undefined, options: GlobalCLIOptions): Promise<WranglerConfigRet> {
    try {
        const projectRoot = normalizePath(root ? path.resolve(root) : process.cwd())
        const wranglerConfig = await loadWranglerConfigFromFile(projectRoot, options.wrangler, options.logLevel)
        const d1s = wranglerConfig.config.d1_databases
        if (!d1s?.length) new Error('No databases found in wrangler config')
        // const r2s = wranglerConfig.config.r2_buckets
        // if(!r2s?.length) new Error('No buckets found in wrangler config')
        const d1Binding = options.db ?? 'PRIMARY_DB'
        const d1 = d1s.find((d: any) => d.binding === (options.db || d1Binding))
        if (!d1) new Error(`Database binding ${d1Binding} not found in wrangler config. ` + (!options.db ? 'Use --db to specify a different database binding' : ''))
        const migrationsDir = d1.migrations_dir
        if (!migrationsDir) new Error('No migrations_dir found in wrangler config. Please specify a migrations_dir in wrangler config (like migrations)')
        return {config: wranglerConfig, db: d1, migrations: migrationsDir}
    }catch (e: any) {
        createLogger(options.logLevel).error(
            colors.red(`error loading wrangler config:\n${e.stack}`),
            {error: e},
        )
        process.exit(1)
    }
}

function readSecretsFile(c: CliContext, throwError = true, apiRoute2?: string) {
    // load secrets from .dev.vars
    const secretsPath = path.join(c.root, c.isLocal ? devVars : prodVars)
    if (!fs.existsSync(secretsPath)) {
        c.logger.error(`Create a file "${readableRelative(secretsPath)}" with the Admin token(${adminTokenKey}) and API route(${apiRouteKey} to connect to the worker`)
        if(throwError) throw new Error(`Secrets file not found at ${secretsPath}`)
        else return {}
    }
    const secrets = dotenv.parse(fs.readFileSync(secretsPath, 'utf8'))
    const adminToken = secrets[adminTokenKey] as string | undefined
    if (!adminToken && throwError) throw new Error(`Admin token(${adminTokenKey}) not found in secrets file at "${readableRelative(secretsPath)}"`)
    let apiRoute = (secrets[apiRouteKey] ?? apiRoute2) as string | undefined
    if (!apiRoute && !c.isLocal && throwError) throw new Error(`API route(${apiRouteKey}) not found in secrets file at "${readableRelative(secretsPath)}"`)
    if (!c.isLocal && apiRoute?.startsWith('http://localhost')) {
        c.logger.warn(`API route(${apiRouteKey}) in secrets file at "${readableRelative(secretsPath)}" is pointing to localhost. This value will be ignored.\nUse the remote API route or remove the variable if not yet deployed.`)
        apiRoute = undefined
        delete secrets[apiRouteKey]
    }
    return {adminToken, apiRoute, secrets}
}

async function fetchWorker(c: CliContext, fPath: string, reqOptions?: RequestInit, logging = false, apiRoute2?: string, parseJson = true) {
    const {adminToken, apiRoute} = readSecretsFile(c, true, apiRoute2)
    const fOptions = {
        method: reqOptions?.method ?? 'GET',
        ...reqOptions,
        headers: {
            'Authorization': `Bearer ${adminToken}`,
            ...reqOptions?.headers,
        } as any
    }
    let _fetch = fetch
    if (c.isLocal) {
        // check if apiRoute is accessible
        const devServerRunning = apiRoute && !c.localWorker ? await fetch(apiRoute, {method: 'HEAD'}).then(r=>true).catch(e => e?.cause?.code !== 'ECONNREFUSED') : false
        if(devServerRunning && apiRoute) fPath = path.join(apiRoute, fPath)
        else _fetch = c.localFetch.bind(c)
    } else {
        if(!apiRoute) throw new Error(`API route(${apiRouteKey}) not found in ${prodVars}`)
        fPath =  path.join(apiRoute, fPath)
    }
    if(logging){
        c.logger.info(`Fetching ${fOptions.method.toUpperCase()}:${fPath}`)
        if(fOptions.body) c.logger.info(fOptions.headers?.['Content-Type']==='application/json'?JSON.parse(fOptions.body as any):fOptions.body as any)
        if(fOptions.headers) c.logger.debug(fOptions.headers as any)
    }else {
        c.logger.debug(`Fetching ${fPath} ${JSON.stringify(fOptions)}`)
    }
    const res = await _fetch(fPath, fOptions)
    const rest = await res.text()
    if(!res.ok) {
        let message = rest
        try{
            const json = JSON.parse(rest)
            message = json.message || json.error || json
            if(logging) c.logger.error(`Failed to fetch ${fPath}. Status: ${res.status}, Response: ${message}\n${JSON.stringify(json, null, 2)}`)
        }catch (_e){}
        throw new Error(`Failed to fetch ${fPath}. Status: ${res.status}, Response: ${typeof message==='string' ? message.slice(0, 1024) : message}`)
    }
    try {
        return rest ? (parseJson ? JSON.parse(rest) : rest) : null
    }catch (e){
        throw new Error(`Failed to parse response from ${fPath}. Status: ${res.status}, Response: ${rest}`)
    }
}

async function fetchDeployedMigrations(c: CliContext) {
    c.logger.info(`Fetching deployed migrations from ${c.isLocal ? 'local' : 'remote'} deployment`)
    loadLocalPersistConfig(c)
    const json = await fetchWorker(c, '/api/v1/migrations', {}).catch(e => {
        if (e.message?.includes('D1_ERROR: no such table: _db_migrations: SQLITE_ERROR')) {
            c.logger.info('No migrations found in deployment')
            return {settings: null, migrations: []}
        }
        throw e
    })
    return json as {settings: DatabaseSettings, migrations: { name: string, sql: string, sql_revert: string }[]}
}

function loadLocalPersistConfig(c: CliContext) {
    if(!c.isLocal) return undefined
    const localConfigPath = path.join(c.localPersistPath, 'config.json')
    if (fs.existsSync(localConfigPath)) {
        let localConfig
        try {
            localConfig = JSON.parse(fs.readFileSync(localConfigPath, 'utf8'))
        } catch (e: any) {
            throw new Error(`Unable to read file ${readableRelative(localConfigPath || '')}\n${e?.message || e}\n\nThis file is not supposed to be manually edited. You may revert any changes, or delete the "${readableRelative(localPersist)}" directory and run again.`)
        }
        // write to migrations/config.json so that fetchDeployedMigrations below can use it in local dev server. if clean is true, this will be deleted.
        if(!fs.existsSync(c.migrationsPath)) fs.mkdirSync(c.migrationsPath, {recursive: true})
        const configPath = path.join(c.migrationsPath, 'config.json')
        fs.writeFileSync(configPath, JSON.stringify(localConfig, null, 2))
        c.logger.info(`Config found in ${readableRelative(c.localPersistPath)}. Written to ${readableRelative(configPath)}`)
        return localConfig
    }
    return undefined
}

async function generateMigrationsDir(c: CliContext, clean = false, write = true) {
    c.logger.info(`Generating/Syncing Migrations folder: ${readableRelative(c.migrationsPath)}`)

    const config = await loadConfigFromFile(c.root, c.options.config, c.options.logLevel)

    let deployed = true
    let lastConfig: Partial<DatabaseSettings>|undefined = undefined
    let lastMigrations: { name: string, sql: string, sql_revert: string }[] = []

    let {migrations: currentMigrations, config: currentConfig, nextConfig: _nextConfig} = readMigrationsFolder(c.migrationsPath)

    // the local server cannot be running/deployed when there is no config.json as it's supposed to directly import it.
    if(c.isLocal && deployed){
        // check if there is a config in localpersist
        currentConfig = loadLocalPersistConfig(c)

        if(!currentConfig) {
            c.logger.info(`No config found at ${readableRelative(path.join(c.migrationsPath, 'config.json'))} or ${readableRelative(c.localPersistPath)}`)
            deployed = false
        }
    }

    if(!c.isLocal && deployed){
        // check if deployed if .prod.vars and apiRoute in that is accessible, then we assume its deployed
        let res = readSecretsFile(c, false)
        if(!res.apiRoute) {
            c.logger.warn(`No API route(${apiRouteKey}) found in ${prodVars}. Assuming not deployed and generating migrations from scratch`)
            deployed = false
        }
    }

    if (deployed) {
        const json = await fetchDeployedMigrations(c)
        if(json.settings === null) deployed = false

        lastConfig = json.settings ? databaseSettingsSchema.parse(json.settings) : undefined
        lastMigrations = json.migrations
    } else {
        // do nothing?
    }

    if(!clean && write){
        // check current folder state since we are not cleaning

        // compare with the last config
        // if different, throw error
        // todo proper check
        const migrationsChanged = JSON.stringify(currentMigrations) !== JSON.stringify(lastMigrations)
        const configChanged = JSON.stringify(currentConfig||{}) !== JSON.stringify(lastConfig||{})
        if (migrationsChanged) {
            throw new Error('Migrations folder has been modified. Apply the migrations first or run with --clean to reset migrations from deployment')
        }
        if (configChanged) {
            throw new Error('Config has been modified. Deploy first or run with --clean to reset migrations from deployment')
        }

        c.logger.info(`Migrations folder and config are up to date with the ${c.isLocal ? 'local' : 'remote'} deployment`)
    }
    // generate migrations for tables
    const index = lastMigrations.length ? parseInt(lastMigrations[lastMigrations.length - 1].name.split('_')[0])+1 : 0
    const {migrations: newMigrations, config: nextConfig_, extraLogs} = generateMigrations(config.config, lastConfig, index)
    const comment = `Config generated by teenybase on ${new Date().toISOString()}. Do not modify this file.`
    const nextConfig = nextConfig_ ? {
        '//': comment,
        ...nextConfig_
    } : undefined

    // when there are no changes, nextConfig is null
    if(!nextConfig){
        c.logger.info('No changes detected in database config')
        if(clean){
            if(!write) throw new Error('Cannot run with clean with no write')
            // delete any next-config.json file from previous runs
            if (_nextConfig){
                fs.unlinkSync(path.join(c.migrationsPath, 'next-config.json'))
            }
            // there could be a mismatch between the migrations we have on disk and what's supposed to be, but that's fine since it will be checked when we actually need to apply anything
        }
        return
    }

    if (clean) {
        if(!write) throw new Error('Cannot run with clean with no write')
        // delete all sql files
        for (const m of currentMigrations) {
            fs.unlinkSync(path.join(c.migrationsPath, m.name))
        }
        // delete config file
        if (currentConfig) {
            fs.unlinkSync(path.join(c.migrationsPath, 'config.json'))
        }
        // delete any next-config.json file from previous runs
        if (_nextConfig){
            fs.unlinkSync(path.join(c.migrationsPath, 'next-config.json'))
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
        if (lastConfig) {
            fs.writeFileSync(path.join(c.migrationsPath, 'config.json'), JSON.stringify(lastConfig, null, 2))
        }
        c.logger.info('Migrations folder cleaned' + (deployed ? ' and reset to deployment' : ''))
        // currentMigrations = []
        // currentConfig = undefined
    }else {
        //
    }

    if(write) {
        // write new migrations
        for (const {name, sql, logs} of newMigrations) {
            const migrationPath = path.join(c.migrationsPath, name)
            const comment = `-- Migration number: ${name.split('_')[0]} generated by teenybase on ${new Date().toISOString()}. Do not modify this file.`
            fs.writeFileSync(migrationPath, [comment, sql].join('\n\n'))
            c.logger.info(`New migration generated - ${name}`)
            for (const log of logs) {
                c.logger.info(' - ' + log)
            }
            c.logger.info('')
        }
        if (!newMigrations.length) {
            c.logger.info('No new migrations generated')
        }
        // write config
        const configPath = path.join(c.migrationsPath, 'next-config.json')
        fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2))
        c.logger.info(`Config generated and written to - ${readableRelative(configPath)}`)
        if(extraLogs?.length){
            for (const log of extraLogs) {
                c.logger.warn(log)
            }
        }
    }

    return {newMigrations, nextConfig, lastMigrations, lastConfig, currentConfig}
}

function wranglerDeploy(c: CliContext, first = false){
    if(c.isLocal) throw new Error('Cannot deploy with --local')
    try {
        const res = execSync(`wrangler deploy`, {cwd: c.root, stdio: first ? ['inherit', 'pipe', 'inherit'] : 'inherit'})
        if(!first) return
        const resB = '' + res
        c.logger.info(resB)
        // setup-db is done just before migrations

        // find deployment route
        let route = resB.match(/https:\/\/[a-zA-Z0-9-.]+\.workers\.dev\r?\n.*Current Version ID:/gm)?.[0].split('\n')[0]
        // if(!route) route = resB.match(/\n[a-zA-Z0-9-.]+ (custom domain)\n*Current Version ID:/gm)?.[0].split('\n').map(r=>'https://'+r)[0]
        return route
    }catch (e: any) {
        const err = '' + e.stdout + '' + e.stderr
        c.logger.error(err)
        const bucketNotFound = err.includes('workers.api.error.bucket_not_found [code: 10085]')
        if(bucketNotFound) {
            c.logger.error('Bucket specified in wrangler.toml is not found. Create a bucket in cloudflare using wrangler and set it in wrangler.toml')
            // throw e
        }
        throw new Error('Unable to deploy worker, check logs above for more details.')
    }
}

function deploySecrets(c: CliContext, secrets: any){
    if(c.isLocal) throw new Error('Cannot deploy with --local')
    // deploy secrets since its the first time
    const tempSecretsPath = path.join(c.root, '.teeny', '.temp-secrets.json')
    try {
        const json = secrets
        // write to .teeny/temp-secrets.json
        fs.mkdirSync(path.dirname(tempSecretsPath), {recursive: true})
        fs.writeFileSync(tempSecretsPath, JSON.stringify(json, null, 2))
        const res = execSync(`wrangler secret bulk ${JSON.stringify(tempSecretsPath)}`, {cwd: c.root, stdio: 'inherit'})
    }catch (e) {
        throw new Error(`Unable to deploy secrets from ${prodVars}, check logs above for more details.`)
    }finally {
        if(fs.existsSync(tempSecretsPath)) fs.unlinkSync(tempSecretsPath)
    }
}

async function migrateAndDeploy(c: CliContext, clean: boolean, doMigrate: boolean, forceDeploy: boolean) {
    const {newMigrations, nextConfig} = await generateMigrationsDir(c, clean).catch(async e => {
        throw e
    }) || {}
    if (newMigrations?.length) {
        if (!doMigrate) {
            throw new Error('There are unapplied migrations. Run with --migrate to apply them')
        }
    }

    const {migrations, config: lastConfig, nextConfig: _nextConfig} = readMigrationsFolder(c.migrationsPath)
    try {
        // this check is not obsolete, don't remove
        if (JSON.stringify(nextConfig||{}) !== JSON.stringify(_nextConfig||{})) {
            throw new Error('Unknown error: nextConfig does not match locally')
        }
        if (nextConfig) {
            c.logger.info('Updating config.json with next-config.json')
            fs.writeFileSync(path.join(c.migrationsPath, 'config.json'), JSON.stringify(nextConfig, null, 2))
        }

        // let deployed = false

        const shouldDeploy = !!nextConfig || newMigrations?.length || forceDeploy
        if(shouldDeploy) {
            const workerName = c.wranglerConfig.config.config.name
            const cfAccountId = c.wranglerConfig.config.config.account_id
            if (!workerName) {
                throw new Error('Required - No worker name(name) found in wrangler config')
            }
            if (!cfAccountId) {
                throw new Error('Required - No cloudflare account id(cfAccountId) found in wrangler config')
            }

            let currentDeployments = []
            let deployRoute = undefined as string|undefined
            if(!c.isLocal) {
                // get current deployments from wrangler
                const commandCD = `wrangler deployments list --json`
                try {
                    c.logger.debug('Fetching current deployments')
                    const cdRes = execSync(commandCD, {
                        cwd: c.root,
                        stdio: ['inherit', 'pipe', 'pipe']
                    }).toString()
                    currentDeployments = JSON.parse(cdRes)
                    // c.logger.info(currentDeployments)
                }catch (e: any) {
                    const err = '' + e?.stderr + '' + e?.stdout
                    const noDeployment = err.includes('This Worker does not exist on your account. [code: 10007]')
                    if(!noDeployment) {
                        c.logger.error(`Unknown error when fetching previous deployments of the worker ${workerName} in cloudflare account ${cfAccountId}. Please try again later.`)
                        throw e
                    }else {
                        // do nothing
                    }
                }
            }

            // deploy if not deployed already
            if (!lastConfig && nextConfig) {
                if (!c.isLocal) {
                    const envSec = readSecretsFile(c, false)
                    if (!envSec.apiRoute && currentDeployments.length) {
                        throw new Error(`Worker is already deployed. API route(${apiRouteKey}) not found in secrets file(${c.isLocal ? devVars : prodVars}).`)
                    }
                    if(envSec.apiRoute && !currentDeployments.length){
                        throw new Error(`Worker is not deployed. API route(${apiRouteKey}) found in secrets file(${c.isLocal ? devVars : prodVars}). Remove it and rerun to deploy a new worker.`)
                    }
                    if(currentDeployments.length){
                        // worker is deployed but setup is not run and migrations not applied.
                        // throw new Error(`Unknown error - Worker is already deployed but no settings and migrations found at ${envSec.apiRoute}`)
                        const message = `Worker is already deployed but no settings and migrations found at ${envSec.apiRoute}`
                        const res = await prompts({
                            type: 'confirm',
                            name: 'value',
                            message: message + '\nDo you want to continue and re-deploy the worker and apply migrations from scratch?',
                            initial: false,
                        });
                        if (!res.value) {
                            throw new Error(`Unknown error - Worker is already deployed but no settings and migrations found at ${envSec.apiRoute}`)
                        }
                    }else {
                        // first time deploy
                        const message = `About to deploy the worker for the first time and upload all the secrets in ${prodVars} with the name ${workerName} in cloudflare account ${cfAccountId}, continue?\nMake sure 'wrangler login' has been run before continuing. This will run 'wrangler deploy' and 'wrangler secret bulk'. `
                        const res = await prompts({
                            type: 'confirm',
                            name: 'value',
                            message: message,
                            initial: true,
                        });
                        if (!res.value) {
                            throw new Error('First time deployment cancelled by user')
                        }

                        try {
                            c.logger.info('Deploying worker for the first time')
                            // at this point, migrations/config.json should contain the nextConfig
                            const configNoTables = {
                                ...nextConfig, tables: []
                            } as DatabaseSettings
                            // write without tables first
                            fs.writeFileSync(path.join(c.migrationsPath, 'config.json'), JSON.stringify(configNoTables, null, 2))
                            let route = wranglerDeploy(c, true)
                            if (!route) {
                                // check if there is custom domain in wrangler config
                                // { pattern = "subdomain.example.com", custom_domain = true }
                                const customDomain = c.wranglerConfig.config.config.routes.find((r: any) => r.custom_domain)?.pattern
                                if (customDomain) route = `https://${customDomain}`
                            }
                            if (!route) {
                                c.logger.error('Unknown error after deploying worker. Deployment route not found.')
                            } else deployRoute = route
                        } catch (e) {
                            // c.logger.error('Unknown error when deploying worker, secrets during first deployment.')
                            throw e
                        } finally {
                            // revert config to nextConfig
                            fs.writeFileSync(path.join(c.migrationsPath, 'config.json'), JSON.stringify(nextConfig, null, 2))
                        }
                        // secrets
                        try {
                            deploySecrets(c, envSec.secrets)
                        } catch (e) {
                            c.logger.error(`Unknown error when deploying worker, secrets during first deployment. Cannot continue. First, run "teeny secrets-deploy" then set the ${apiRouteKey} in ${prodVars} and rerun the command to migrate.`)
                            throw e
                        }
                    }

                    // deployed = true
                } else {
                    // local deploy, nothing to do with wrangler
                    if(nextConfig) {
                        // at this point, migrations/config.json should contain the nextConfig
                        // write the nextConfig also to localPersist so we know for next time what config was saved
                        const localConfigPath = path.join(c.localPersistPath, 'config.json')
                        fs.mkdirSync(path.dirname(localConfigPath), {recursive: true})
                        fs.writeFileSync(localConfigPath, JSON.stringify(nextConfig, null, 2))
                    }
                }
            }

            if (nextConfig || newMigrations?.length) {
                if(!c.isLocal && !currentDeployments.length && !deployRoute){ // first deployment, we need API_ROUTE in vars to continue.
                    c.logger.info('The worker has been deployed for the first time but deployment route not found. Cannot continue with the migration')
                    c.logger.info(`Set the ${apiRouteKey} in ${prodVars} and rerun the command to migrate.`)
                    // process.exit(1)
                    throw new Error('Deployment route not found')
                }

                // make sure db is deployed and initial setup is done. Note - don't setup during first deployment.
                await fetchWorker(c, '/api/v1/setup-db', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    }
                }, false, deployRoute)

                if (newMigrations?.length) {
                    const message = `About to apply ${newMigrations.length} migration(s)\n Your database may not be available to serve requests during the migration, continue?`
                    const res = await prompts({
                        type: 'confirm',
                        name: 'value',
                        message: message,
                        initial: false,
                    });
                    if (!res.value) {
                        throw new Error('Migration cancelled by user')
                    }
                }

                c.logger.info(`Syncing ${migrations.length} migrations, with ${newMigrations?.length || 0} new migrations`)
                // logger.info(migrations.map((m) => ` - ${m.name}`).join('\n'))

                try {
                    // todo ideally apply migrations should be done directly by wrangler/cloudflare api and not through this route.
                    //  note - we are not using wrangler because it has a different schema for migrations table without the sql code.
                    const json = await fetchWorker(c, '/api/v1/migrations', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({migrations, settings: nextConfig || lastConfig}),
                    }, false, deployRoute)
                    if (!json.applied?.length) {
                        if (newMigrations?.length) {
                            throw new Error(`Unable to apply ${newMigrations.length} new migrations`)
                        }
                        c.logger.warn('No migrations applied')
                    } else {
                        c.logger.info(`Applied ${json.applied.length} migrations successfully`)
                        c.logger.info(json.applied.map((m: any) => ` ✅ ${m}`).join('\n'))
                        if (newMigrations?.length !== json.applied.length) {
                            // this should never happen actually since they are applied as batch
                            const unapplied = newMigrations?.filter(m => !json.applied.includes(m.name)) ?? []
                            c.logger.error(unapplied.map((m) => ` ❌ ${m.name}`).join('\n'))
                            throw new Error(`Unknown error - Only ${json.applied.length} of ${newMigrations?.length} new migrations applied`)
                        }
                    }
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

            // todo deploy first and rollback if migration fails
            if (true /*!deployed*//* && (nextConfig || newMigrations?.length || forceDeploy)*/) {
                if (!c.isLocal) {
                    wranglerDeploy(c)
                } else {
                    // local worker is automatically deployed with new settings when next-config.json is written to config.json

                    if(nextConfig) {
                        // write the nextConfig also to localPersist
                        const localConfigPath = path.join(c.localPersistPath, 'config.json')
                        fs.mkdirSync(path.dirname(localConfigPath), {recursive: true})
                        fs.writeFileSync(localConfigPath, JSON.stringify(nextConfig, null, 2))
                    }
                }
            }
            if(nextConfig) {
                c.logger.info('Removing next-config.json')
                fs.unlinkSync(path.join(c.migrationsPath, 'next-config.json'))
            }

            if(!c.isLocal && !currentDeployments.length){
                c.logger.info(`\n`)
                c.logger.info(`The worker has been deployed for the first time at ${deployRoute}`)
                c.logger.info(`Set the ${apiRouteKey} to "${deployRoute}" in "${prodVars}" file to connect to the worker from next time.`)
            }
        }else {
            if(!c.isLocal)
                c.logger.info('Skipping worker deployment. No changes detected in database config and migrations. Run with --deploy to deploy anyway')
        }
    } catch (e: any) {
        if (nextConfig) {
            c.logger.warn('Reverting config.json due to error')
            const cp = path.join(c.migrationsPath, 'config.json')
            if (lastConfig) {
                fs.writeFileSync(cp, JSON.stringify(lastConfig, null, 2))
            } else if(fs.existsSync(cp)) {
                fs.unlinkSync(cp)
            }
            if(c.isLocal && lastConfig){
                const localConfigPath = path.join(c.localPersistPath, 'config.json')
                fs.mkdirSync(path.dirname(localConfigPath), {recursive: true})
                fs.writeFileSync(localConfigPath, JSON.stringify(lastConfig, null, 2))
            }
        }
        throw e
    }
}

process.env.WRANGLER_SEND_METRICS = 'false'
process.env.WRANGLER_LOG = 'log' // none, error, warn, info, log, debug - https://github.com/cloudflare/workers-sdk/blob/3dce3881bdaf373aa9b2e52483e340ab8193151c/packages/wrangler/src/logger.ts#L10

const cli = cac('teeny')

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
    .action(
        async (
            options: GlobalCLIOptions & { clean: boolean },
        ) => {
            filterDuplicateOptions(options)
            const wranglerConfig = await parseWrangler(options.root, options)
            const c = new CliContext(options.root, options, wranglerConfig)

            await generateMigrationsDir(c, Boolean(options.clean??true)).catch(async e=>{
                c.logger.error(
                    colors.red(`error when generating migrations:\n${e.stack}`),
                    {error: e},
                )
                // console.error(e)
                await c.stopLocal()
                process.exit(1)
            }).finally(()=>{
                // stopProfiler((message) => createLogger(options.logLevel).info(message))
            })
            await c.stopLocal()

        },
    )

// apply migrations
cli
    .command('migrate', 'apply migrations and deploy worker')
    .option(
        '--deploy',
        `[boolean] deploy the worker even if there are no teenybase config changes (default: false)`,
    )
    .option(
        '--migrate',
        `[boolean] apply new migrations. If disabled, this will throw an error if there are new/unapplied migrations (default: true)`,
    )
    .option(
        '--clean',
        `[boolean] delete migrations folder and download latest from deployment before generating (default: true)`,
    )
    .action(
        async (
            options: /*BuildEnvironmentOptions & BuilderCLIOptions &*/ GlobalCLIOptions & { clean?: boolean, deploy?: boolean, migrate?: boolean },
        ) => {
            filterDuplicateOptions(options)
            const wranglerConfig = await parseWrangler(options.root, options)
            const c = new CliContext(options.root, options, wranglerConfig)

            const forceDeploy = Boolean(options.deploy??false)
            const doMigrate = Boolean(options.migrate??true)
            const clean = Boolean(options.clean??true)
            await migrateAndDeploy(c, clean, doMigrate, forceDeploy).catch(async e=>{
                c.logger.error(
                    colors.red(`error when applying migrations and deploying:\n${e.stack}`),
                    {error: e},
                )
                await c.stopLocal()
                process.exit(1)
            })
            await c.stopLocal()
        },
    )

// deploy worker
cli
    .command('deploy', 'deploy worker and optionally apply migrations. This is same as migrate command but with different defaults')
    .option(
        '--deploy',
        `[boolean] deploy the worker even if there are no teenybase config and migrations changes (default: true)`,
    )
    .option(
        '--migrate',
        `[boolean] apply new migrations. If enabled, this will prompt to apply new migrations otherwise this will throw an error if there are new/unapplied migrations (default: false)`,
    )
    .option(
        '--clean',
        `[boolean] delete migrations folder and download latest from deployment before generating (default: true)`,
    )
    .action(
        async (
            options: /*BuildEnvironmentOptions & BuilderCLIOptions &*/ GlobalCLIOptions & { clean?: boolean, deploy?: boolean, migrate?: boolean },
        ) => {
            filterDuplicateOptions(options)
            const wranglerConfig = await parseWrangler(options.root, options)
            const c = new CliContext(options.root, options, wranglerConfig)

            const forceDeploy = Boolean(options.deploy??true)
            const doMigrate = Boolean(options.migrate??true)
            const clean = Boolean(options.clean??true)
            await migrateAndDeploy(c, clean, doMigrate, forceDeploy).catch(async e=>{
                c.logger.error(
                    colors.red(`error when applying migrations and deploying:\n${e.stack}`),
                    {error: e},
                )
                await c.stopLocal()
                process.exit(1)
            })
            await c.stopLocal()
        },
    )


// deploy secrets
cli
    .command('secrets', 'deploy worker and optionally apply migrations. This is same as migrate command but with different defaults')
    .option(
        '--upload',
        `[boolean] deploy the worker even if there are no teenybase config and migrations changes (default: false)`,
    )
    .action(
        async (
            options: /*BuildEnvironmentOptions & BuilderCLIOptions &*/ GlobalCLIOptions & { upload?: boolean },
        ) => {
            filterDuplicateOptions(options)
            const wranglerConfig = await parseWrangler(options.root, options)
            const c = new CliContext(options.root, options, wranglerConfig)

            const doUpload = Boolean(options.upload??false)
            const envRes = readSecretsFile(c, false)
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
            const cfAccountId = c.wranglerConfig.config.config.account_id
            if (!workerName) {
                throw new Error('Required - No worker name(name) found in wrangler config')
            }
            if (!cfAccountId) {
                throw new Error('Required - No cloudflare account id(cfAccountId) found in wrangler config')
            }

            const message = `About to upload(create/replace) ${secretKeys.length} secrets to the worker ${workerName} in cloudflare account ${cfAccountId}, continue?\nMake sure 'wrangler login' has been run before continuing. This will run 'wrangler secret bulk'. `
            const res = await prompts({
                type: 'confirm',
                name: 'value',
                message: message,
                initial: true,
            });
            if (!res.value) {
                throw new Error('Secrets upload cancelled by user')
            }

            try {
                deploySecrets(c, envRes.secrets)
            }catch (e: any){
                c.logger.error(
                    colors.red(`error when applying migrations and deploying:\n${e.stack}`),
                    {error: e},
                )
                await c.stopLocal()
                process.exit(1)
            }
            await c.stopLocal()
        },
    )

// dev
cli
    .command('dev', 'start wrangler dev server')
    .action(
        async (
            options: /*BuildEnvironmentOptions & BuilderCLIOptions &*/ GlobalCLIOptions & { clean: boolean, generate: boolean },
        ) => {
            filterDuplicateOptions(options)
            const logger = createLogger(options.logLevel)
            const wranglerConfig = await parseWrangler(options.root, options)
            const c = new CliContext(options.root, options, wranglerConfig)

            try {
                if(!options.local) {
                    throw new Error('Remote dev server not support at the moment.')
                }

                loadLocalPersistConfig(c)

                // this check is for first time when .local-persist/config.json also doesn't exist
                const configPath = path.join(c.migrationsPath, 'config.json')
                if(!fs.existsSync(c.migrationsPath) || !fs.existsSync(configPath)){
                    throw new Error(`Migrations or Config file not found. First run "teeny migrate ${c.isLocal ? '--local':'--remote'}" to generate and apply migrations to the ${c.isLocal ? 'local':'remote'}" database.`)
                    // process.exit(1)
                }

                const command = `npx wrangler dev --persist-to ${JSON.stringify(c.localPersistPath)}`
                execSync(command, {cwd: c.root, stdio: 'inherit'})
                await c.stopLocal()
            } catch (e: any) {
                logger.error(
                    colors.red(`error when running wrangler dev:\n${e.stack}`),
                    { error: e },
                )
                await c.stopLocal()
                process.exit(1)
            } finally {
                // stopProfiler((message) => createLogger(options.logLevel).info(message))
            }
        },
    )

// backup
cli
    .command('backup', 'backup database and schema')
    .action(
        async (
            options: /*BuildEnvironmentOptions & BuilderCLIOptions &*/ GlobalCLIOptions,
        ) => {
            filterDuplicateOptions(options)
            const wranglerConfig = await parseWrangler(options.root, options)
            const c = new CliContext(options.root, options, wranglerConfig)

            try {
                const dir = `db_backups/${options.local?'local':'remote'}/${wranglerConfig.db.binding}/${new Date().toISOString()}`
                const absDir = path.join(c.root, dir)
                fs.mkdirSync(absDir, {recursive: true})
                const migrations = await fetchDeployedMigrations(c)
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

                if(options.local){
                    // this is required since wrangler doesn't support persist-to for export command
                    await exportLocal(wranglerConfig.config.config, wranglerConfig.db.binding, path.join(absDir, 'schema.sql'), [], false, true, c.localPersistPath, c.logger)
                    await exportLocal(wranglerConfig.config.config, wranglerConfig.db.binding, path.join(absDir, 'data.sql'), [], true, false, c.localPersistPath, c.logger)
                }else {
                    const command = `npx wrangler d1 export ${wranglerConfig.db.binding} ${options.local ? `--local --persist-to ${JSON.stringify(c.localPersistPath)}` : '--remote'} --no-data --output ${JSON.stringify(path.join(absDir, 'schema.sql'))}`
                    const command2 = `npx wrangler d1 export ${wranglerConfig.db.binding} ${options.local ? `--local --persist-to ${JSON.stringify(c.localPersistPath)}` : '--remote'} --no-schema --output ${JSON.stringify(path.join(absDir, 'data.sql'))}`
                    execSync(command, {cwd: c.root, stdio: 'inherit'})
                    execSync(command2, {cwd: c.root, stdio: 'inherit'})
                }
                await c.stopLocal()
            } catch (e: any) {
                c.logger.error(
                    colors.red(`error when exporting backend backup:\n${e.stack}`),
                    { error: e },
                )
                await c.stopLocal()
                process.exit(1)
            } finally {
                // stopProfiler((message) => createLogger(options.logLevel).info(message))
            }
        },
    )

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
    .action(
        async (
            options: GlobalCLIOptions & { outDir?: string },
        ) => {
            filterDuplicateOptions(options)
            const wranglerConfig = await parseWrangler(options.root, options)
            const c = new CliContext(options.root, options, wranglerConfig)

            const {nextConfig} = await generateMigrationsDir(c, false, false).catch(async e=>{
                c.logger.error(
                    colors.red(`error when generating migrations:\n${e.stack}`),
                    {error: e},
                )
                // console.error(e)
                await c.stopLocal()
                process.exit(1)
            }).finally(()=>{
                // stopProfiler((message) => createLogger(options.logLevel).info(message))
            }) || {}

            c.logger.info('Starting Build')

            if(!fs.existsSync(c.migrationsPath)) fs.mkdirSync(c.migrationsPath, {recursive: true})
            const configFile = path.join(c.migrationsPath, 'config.json') // = ./migrations/config.json
            const configData = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null
            try {
                // write the current generated one so that build can use it, we will delete it later
                if(nextConfig){
                    c.logger.debug('Temporarily writing next-config to config.json')
                    fs.writeFileSync(configFile, JSON.stringify(nextConfig, null, 2))
                }else{
                    // no new changes
                }
                const outDir = options.outDir || path.join(c.root, 'dist')
                const res = c.buildLocal(outDir, true, true, false)
                if(res) c.logger.info(`Finished Build. Written to "${readableRelative(outDir)}"`)
                await c.stopLocal()
                // c.logger.info(res)
            } catch (e: any) {
                createLogger(options.logLevel).error(
                    colors.red(`error during build:\n${e.stack}`),
                    { error: e },
                )
                await c.stopLocal()
                process.exit(1)
            } finally {
                if(nextConfig) {
                    // revert the config
                    c.logger.debug('Reverting config.json')
                    if (!configData) {
                        if(fs.existsSync(configFile)) fs.unlinkSync(configFile)
                    }
                    else fs.writeFileSync(configFile, configData)
                }
                // stopProfiler((message) => createLogger(options.logLevel).info(message))
            }
        },
    )

// exec
cli
    .command('exec <route>', 'execute a route on the worker with admin token')
    .option('-m, --method <method>', `[string] http method (default: GET)`)
    .option('-d, -b, --data, --body <body>', `[string] http body`)
    .option('-y, --yes', `[boolean] skip confirmation. only for non-GET requests (default: false)`)
    .option('-r, --raw', `[boolean] output raw response (default: false)`)
    .option('--explain', `[boolean] dry run and return the queries that will be executed (default: false)`)
    .action(
        async (
            route: string,
            options: GlobalCLIOptions & { method?: string, body?: string, yes?: boolean, raw?: boolean, explain?: boolean },
        ) => {
            filterDuplicateOptions(options)
            const wranglerConfig = await parseWrangler(options.root, options)
            const c = new CliContext(options.root, options, wranglerConfig, "warn")

            try {
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
                const res = await fetchWorker(c, routePath, {
                    method: options.method || 'GET',
                    body: options.body,
                    headers: {
                        'Content-Type': 'application/json',
                    }
                }, !options.raw, undefined, !options.raw)
                if(!options.raw) {
                    c.logger.info('Request completed. Response:')
                    c.logger.info(res)
                }else {
                    console.log(res)
                }
                await c.stopLocal()
            } catch (e: any) {
                createLogger(options.logLevel).error(
                    colors.red(`error during exec:\n${e.stack}`),
                    { error: e },
                )
                await c.stopLocal()
                process.exit(1)
            } finally {
                // stopProfiler((message) => createLogger(options.logLevel).info(message))
            }
        },
    )

cli.help()
cli.version(VERSION)

cli.parse()
