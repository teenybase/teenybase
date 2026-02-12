import colors from 'picocolors'
import prompts from 'prompts'
import path from 'path'
import fs from 'node:fs'
import {execSync} from 'node:child_process'
import {createLogger, Logger, LogLevel} from './logger'
import {unstable_dev, Unstable_DevOptions, Unstable_DevWorker} from 'wrangler'
import {escapeRegExp, normalizePath, readableRelative} from './utils'
import {loadConfigFromFile, loadWranglerConfigFromFile} from './config'
import {DatabaseSettings} from '../types/config'
import dotenv from 'dotenv'
import {URL} from 'url'
import {generateMigrations} from '../sql/schema/generateMigrations'
import {jsonStringify} from '../utils/string'
import {databaseSettingsSchema} from '../types/zod/databaseSettingsSchema'
import {RequestInfo} from '@cloudflare/workers-types'
import {DBMigration, MigrationHelperRaw} from '../worker/migrationHelper'
import {InternalKV} from '../worker/internalKV'
import {$DatabaseRawImpl} from '../worker/$DatabaseRawImpl'

export const adminTokenKey = 'ADMIN_SERVICE_TOKEN'
export const apiRouteKey = 'API_ROUTE'
export const devVars = '.dev.vars'
export const prodVars = '.prod.vars'

// todo issue -
//  after deploying the worker (either first time or subsequent),
//  it is possible that it breaks the deployment (like when jwt secret cannot be resolved).
//  after that when calling setup-db or fetch migrations, it returns an error, and we cannot do anything like generate, migrate or deploy
//  to fix it, the only option is to re-deploy from scratch.
//  to reproduce -
//   delete local-persist in the notes-sample, change JWT_SECRET_MAIN to ABC in teenybase.ts and run migrate.
//   other way - in an existing deployment, make the same change in .local-persist/config.json and run migrate.
//   both will break the application

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

export const filterDuplicateOptions = <T extends object>(options: GlobalCLIOptions&T) => {
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

export class CliContext{
    localWorker: Unstable_DevWorker|undefined
    readonly migrationsPath: string
    get isLocal(){
        return !this.options.remote
    }
    readonly root: string
    readonly logger: Logger
    readonly devServerLogLevel: Unstable_DevOptions['logLevel']
    readonly devServerPort: number
    constructor(root: string|undefined, public options: GlobalCLIOptions, public wranglerConfig: WranglerConfigRet, devServerLogLevel: Unstable_DevOptions['logLevel'] = "none") {
        this.logger = createLogger(options.logLevel)
        this.root = normalizePath(root ? path.resolve(root) : process.cwd())
        this.migrationsPath = path.join(this.root, wranglerConfig.migrations)
        this.devServerLogLevel = devServerLogLevel
        this.devServerPort = parseInt(process.env.TEENY_DEV_PORT || wranglerConfig.config.dev?.port || '8787')
        if(isNaN(this.devServerPort) || this.devServerPort <= 0 || this.devServerPort >= 65536){
            throw new Error(`Invalid port number specified in TEENY_PORT environment variable: ${process.env.TEENY_PORT}`)
        }
    }

    get localPersistPath(){
        return path.join(this.root, localPersist)
    }

    buildLocal(config: DatabaseSettings, outDir?: string, log = true, doThrow = true, clean = false, flags: string = ''): boolean{
        const _outDir = outDir ?
            // explicit path is always resolved from cwd
            path.resolve(outDir) :
            path.join(this.root, '.teeny', 'tmp', 'dist-worker')
        const lastWLogEnv = process.env.WRANGLER_LOG
        process.env.WRANGLER_LOG = log ? 'info' : 'error'
        try {
            const command = `npx wrangler deploy --dry-run ${flags} --outdir=${JSON.stringify(_outDir)} --tsconfig=${JSON.stringify(this.createCustomTsconfigForWorker(config, 'bl'))}`
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
            this.removeCustomTsconfig('bl')
        }
    }

    private _startingPromise: Promise<Unstable_DevWorker>|undefined
    async startLocal(){
        if(this.localWorker) return this.localWorker
        if(this._startingPromise) return await this._startingPromise
        const localConfig = loadLocalPersistConfig(this)
        if(!localConfig){
            throw new Error(`No local config found in ${readableRelative(path.join(this.localPersistPath, 'config.json'))}. Starting local worker without persistence. Run "teeny migrate --local" to generate the local config.`)
        }
        const built = this.buildLocal(localConfig, undefined, false, false, true)
        if(!built){
            throw new Error('Unable to build and connect to local worker. Run "teeny dev --local" to check the errors.')
        }

        if(this.options.local) this.logger.debug('Local worker starting')
        this._startingPromise = this.options.local ? unstable_dev(this.wranglerConfig.config.main, {
            moduleRoot: this.root,
            // config: wranglerConfig.config,
            port: this.devServerPort,
            local: true,
            bundle: true,
            persistTo: this.localPersistPath,
            logLevel: this.devServerLogLevel, //"none",
            // logLevel: "info",
            experimental: {
                disableExperimentalWarning: true,
            },
            // @ts-expect-error types are wrong
            tsconfig: this.createCustomTsconfigForWorker(localConfig, 'dev'),
        }) : undefined
        this.localWorker = await this._startingPromise
        if(this.localWorker) this.logger.debug('Local worker started')
        return this.localWorker
    }
    async localFetch(input?: RequestInfo, init?: RequestInit): Promise<Response>{
        const w = await this.startLocal()
        if(!w) throw new Error('Unable to start local worker')
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
        this.removeCustomTsconfig('dev')
    }

    createCustomTsconfigForWorker(config: DatabaseSettings, suffix = 'worker'){
        const tempConfigDir = path.join(this.root, '.teeny')
        const tempConfigPath = path.join(tempConfigDir, `.tmp.config.${suffix}.json`)

        const tsconfigPath = path.join(this.root, `.tmp.tsconfig.${suffix}.json`)
        const currentTsconfig = path.join(this.root, this.wranglerConfig.config.tsConfig || 'tsconfig.json')
        const currentTsconfigContent = fs.existsSync(currentTsconfig) ? JSON.parse(fs.readFileSync(currentTsconfig, 'utf-8')) : {}
        const customTsconfigContent = {
            "extends": normalizePath(path.relative(path.dirname(tsconfigPath), currentTsconfig)),
            "compilerOptions": {
                "paths": {
                    // copying because they are not merged
                    ...(currentTsconfigContent.compilerOptions?.paths || {}),
                    "virtual:teenybase": [path.relative(path.dirname(currentTsconfig), tempConfigPath)],
                }
            }
        }
        fs.writeFileSync(tsconfigPath, JSON.stringify(customTsconfigContent, null, 2))

        if (!fs.existsSync(tempConfigDir)) fs.mkdirSync(tempConfigDir, {recursive: true})
        fs.writeFileSync(tempConfigPath, JSON.stringify(config, null, 2))

        return tsconfigPath
    }

    removeCustomTsconfig(suffix: string){
        const tsconfigPath = path.join(this.root, `.tmp.tsconfig.${suffix}.json`)
        fs.unlinkSync(tsconfigPath)
        const tempConfigPath = path.join(this.root, `.tmp.config.${suffix}.json`)
        fs.unlinkSync(tempConfigPath)
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
    config: any
    db: { binding: string, migrations_dir: string }
    migrations: string
}

export async function parseWrangler(root: string|undefined, options: GlobalCLIOptions): Promise<WranglerConfigRet> {
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
        createLogger(options.logLevel).error(
            colors.red(`error loading wrangler config:\n${e.stack}`),
            {error: e},
        )
        process.exit(1)
    }
}

export function readSecretsFile(c: CliContext, throwError = true, apiRoute2?: string) {
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
    let apiRoute = (secrets[apiRouteKey] ?? apiRoute2)?.trim() as string | undefined

    if(apiRoute){
        const lowerApiRoute = apiRoute.toLowerCase().trim()
        if(!lowerApiRoute || lowerApiRoute === 'null' || lowerApiRoute === 'undefined' || lowerApiRoute === 'na' || lowerApiRoute === 'none'){
            apiRoute = undefined
        }
    }
    let parsedApiRoute
    if(apiRoute) {
        try {
            parsedApiRoute = new URL(apiRoute || 'http://example.com') // dummy url
        }catch (e){
            throw new Error(`API route(${apiRouteKey}) in secrets file at "${readableRelative(secretsPath)}" is not a valid URL.`)
        }
        if (!['http:', 'https:'].includes(parsedApiRoute.protocol)) {
            throw new Error(`API route(${apiRouteKey}) in secrets file at "${readableRelative(secretsPath)}" must start with http:// or https://`)
        }
    }

    if (!apiRoute && !c.isLocal && throwError) throw new Error(`API route(${apiRouteKey}) not found in secrets file at "${readableRelative(secretsPath)}"`)
    if (!c.isLocal && apiRoute?.startsWith('http://localhost')) {
        c.logger.warn(`API route(${apiRouteKey}) in secrets file at "${readableRelative(secretsPath)}" is pointing to localhost. This value will be ignored.\nUse the remote API route or remove the variable if not yet deployed.`)
        apiRoute = undefined
        delete secrets[apiRouteKey]
    }
    if(c.isLocal) {
        if (!apiRoute) {
            apiRoute = 'http://localhost:' + c.devServerPort
        }else if(parsedApiRoute && parsedApiRoute.port && parsedApiRoute.port !== ('' + c.devServerPort) && parsedApiRoute.hostname === 'localhost') {
            c.logger.warn(`API route(${apiRouteKey}) in secrets file at "${readableRelative(secretsPath)}" has port ${parsedApiRoute.port} which is different from the local dev server port ${c.devServerPort}. Using port ${c.devServerPort} instead.`)
            apiRoute = `${parsedApiRoute.protocol}//${parsedApiRoute.hostname}:${c.devServerPort}`
        }
    }
    return {adminToken, apiRoute, secrets}
}

export async function fetchWorker(c: CliContext, fPath: string, reqOptions?: RequestInit, logging = false, apiRoute2?: string, parseJson = true) {
    const {adminToken, apiRoute} = readSecretsFile(c, true, apiRoute2)
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
        // check if apiRoute is accessible using the health endpoint
        const devServerRunning = apiRoute && !c.localWorker ? await fetch(path.join(apiRoute, '/api/v1/health'), {
            method: 'GET',
            signal: AbortSignal.timeout(1000)
        }).then(r=>r.ok).catch(e => {
            return !!e && e.cause?.code !== 'ECONNREFUSED' && e.name !== 'TimeoutError' // todo better check
        }) : false
        if(devServerRunning && apiRoute) fPath = path.join(apiRoute, fPath)
        // @ts-expect-error check in next version, type mismatch between undici and cloudflare workers, but should be compatible
        else _fetch = c.localFetch.bind(c)
    } else {
        if(!apiRoute) throw new Error(`API route(${apiRouteKey}) not found in ${prodVars}`)
        fPath = path.join(apiRoute, fPath)
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
            message = ((json.message ? json.message + ' ' : '') + ((json.error || json.data?.error) + '')) || json
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

export async function fetchDeployedMigrations(c: CliContext, kvTableName: string|undefined) {
    c.logger.info(`Fetching deployed migrations from ${c.isLocal ? 'local' : 'remote'} deployment`)

    let migrations: DBMigration[]|null = null
    let settings: DatabaseSettings | null = null
    try {
        const db = new $DatabaseRawImpl()
        db.auth.superadmin = true
        const kv = new InternalKV(db, kvTableName)
        const helper = new MigrationHelperRaw(db, kv, undefined) // todo migration table name is fixed
        migrations = await helper.list().catch(e=>{
            // setup not done yet, todo test
            if (e.message?.includes(`no such table: ${helper.tableName}`)) {
                c.logger.info('No migrations found in deployment')
                return []
            }
            throw e
        })
        settings = await helper.dbSettings() || null
        if(!settings){
            throw new Error('No settings found in the database state.')
        }
        return {settings, migrations}
    }catch (e) {
        console.warn(e)
        console.warn('Fallback to fetch migrations and settings through API.')
        try {
            const json = await fetchWorker(c, '/api/v1/migrations', {}).catch(e => {
                // setup not done yet
                if (e.message?.includes(`no such table: ${MigrationHelperRaw.DEFAULT_TABLE_NAME}`)) {  // todo migration table name is fixed
                    c.logger.info('No migrations found in deployment')
                    return {settings: null, migrations: []}
                }
                throw e
            })
            return json as { settings: DatabaseSettings, migrations: DBMigration[] }
        }catch (e) {
            // if(migrations){
            //     return {settings, migrations}
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
    c.logger.info(`Generating/Syncing Migrations folder: ${readableRelative(c.migrationsPath)}`)

    const config = await loadConfigFromFile(c.root, c.options.config, c.options.logLevel)

    let deployed = true
    let lastConfig: DatabaseSettings|undefined = undefined
    let lastMigrations: DBMigration[] = []

    let {migrations: currentMigrations, /*config: currentConfig, */nextConfig: _nextConfig} = readMigrationsFolder(c.migrationsPath)

    // the local server cannot be running/deployed when there is no config.json as it's supposed to directly import it.
    if(c.isLocal && deployed){
        // check if there is a config in localpersist
        const hasLocalConfig = !!loadLocalPersistConfig(c)

        if(!hasLocalConfig) {
            c.logger.info(`No config found at ${readableRelative(c.localPersistPath)}`)
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
        const json = await fetchDeployedMigrations(c, config.config._kvTableName)
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
        const migrationsChanged = jsonStringify(currentMigrations) !== jsonStringify(lastMigrations)
        // const configChanged = jsonStringify(currentConfig||{}) !== jsonStringify(lastConfig||{})
        if (migrationsChanged) {
            throw new Error('Migrations folder has been modified. Apply the migrations first or run with --clean to reset migrations from deployment')
        }
        // if (configChanged) {
        //     throw new Error('Config has been modified. Deploy first or run with --clean to reset migrations from deployment')
        // }

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
        // if (lastConfig) {
        //     fs.writeFileSync(path.join(c.migrationsPath, 'config.json'), JSON.stringify(lastConfig, null, 2))
        // }
        c.logger.info('Migrations folder cleaned' + (deployed ? ' and reset to deployment' : ''))
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
        return {newMigrations: [], nextConfig: undefined, lastMigrations, lastConfig, deployed/*, currentConfig*/}
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

    return {newMigrations, nextConfig, lastMigrations, lastConfig, deployed/*, currentConfig*/}
}

export function wranglerDeploy(c: CliContext, config: DatabaseSettings, first = false){
    if(c.isLocal) throw new Error('Cannot deploy with --local')
    try {
        const res = execSync(
            `wrangler deploy --tsconfig=${JSON.stringify(c.createCustomTsconfigForWorker(config, 'deploy'))}`,
            {cwd: c.root, stdio: first ? ['inherit', 'pipe', 'inherit'] : 'inherit'})
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
    }finally{
        c.removeCustomTsconfig('deploy')
    }
}

export function localPersistDeploy(lastConfig: Partial<DatabaseSettings>|undefined, c: CliContext){
    const localConfigPath = path.join(c.localPersistPath, 'config.json')
    if(lastConfig) {
        fs.mkdirSync(path.dirname(localConfigPath), {recursive: true})
        fs.writeFileSync(localConfigPath, JSON.stringify(lastConfig, null, 2))
    }else if(fs.existsSync(localConfigPath)) fs.unlinkSync(localConfigPath)

}

export function deploySecrets(c: CliContext, secrets: any){
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

export async function migrateAndDeploy(c: CliContext, clean: boolean, doMigrate: boolean, forceDeploy: boolean, skipConfirmation: boolean = false) {
    const {newMigrations, nextConfig, lastConfig} = await generateMigrationsDir(c, clean).catch(async e => {
        throw e
    })
    if (newMigrations?.length) {
        if (!doMigrate) {
            throw new Error('There are unapplied migrations. Run with --migrate to apply them')
        }
    }
    let newSettingsSavedInDb = false

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
                        if (!skipConfirmation) {
                            const res = await prompts({
                                type: 'confirm',
                                name: 'value',
                                message: message + '\nDo you want to continue and re-deploy the worker and apply migrations from scratch?',
                                initial: false,
                            });
                            if (!res.value) {
                                throw new Error(`Unknown error - Worker is already deployed but no settings and migrations found at ${envSec.apiRoute}`)
                            }
                        } else {
                            c.logger.info(message)
                            c.logger.info('Continuing with re-deployment (--yes flag provided)')
                        }
                    }else {
                        // first time deploy
                        const message = `About to deploy the worker for the first time and upload all the secrets in ${prodVars} with the name ${workerName} in cloudflare account ${cfAccountId}, continue?\nMake sure 'wrangler login' has been run before continuing. This will run 'wrangler deploy' and 'wrangler secret bulk'. `
                        if (!skipConfirmation) {
                            const res = await prompts({
                                type: 'confirm',
                                name: 'value',
                                message: message,
                                initial: true,
                            });
                            if (!res.value) {
                                throw new Error('First time deployment cancelled by user')
                            }
                        }else {
                            c.logger.info(message)
                            c.logger.info('Continuing with first time deployment (--yes flag provided)')
                        }

                        try {
                            c.logger.info('Deploying worker for the first time')


                            // write without tables first (because its first time deployment without any migrations)
                            const configNoTables = {
                                ...nextConfig, tables: []
                            } as DatabaseSettings

                            let route = wranglerDeploy(c, configNoTables, true)
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
                            // fs.writeFileSync(path.join(c.migrationsPath, 'config.json'), JSON.stringify(nextConfig, null, 2))
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
                        localPersistDeploy(nextConfig, c)
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

                // c.logger.info('Setting up db')
                // make sure db is deployed and initial setup is done. Note - don't setup during first deployment.
                await fetchWorker(c, '/api/v1/setup-db', { // todo handle database settings mismatch error from this endpoint. we need to first deploy the worker with the settings in the db and then apply migrations.
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    }
                }, false, deployRoute)

                if (newMigrations?.length) {
                    const message = `About to apply ${newMigrations.length} migration(s)\n Your database may not be available to serve requests during the migration, continue?`
                    if (!skipConfirmation) {
                        const res = await prompts({
                            type: 'confirm',
                            name: 'value',
                            message: message,
                            initial: false,
                        });
                        if (!res.value) {
                            throw new Error('Migration cancelled by user')
                        }
                    } else {
                        c.logger.info(message)
                        c.logger.info('Continuing with migration (--yes flag provided)')
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
                        body: JSON.stringify({migrations, settings: nextConfig || lastConfig}), // this will also save the settings in the db
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

            if (true /*!deployed*//* && (nextConfig || newMigrations?.length || forceDeploy)*/) { // todo check if we need to deploy
                if (!c.isLocal) {
                    const config = nextConfig || lastConfig
                    if(config) {
                        // todo incase of error during deployment, we need to prompt user to run the migrate again
                        wranglerDeploy(c, config)
                    }else {
                        c.logger.error('No config to deploy, skipping wrangler deploy')
                    }
                } else {
                    // local worker is automatically deployed with new settings when next-config.json is written to config.json
                    if(nextConfig) {
                        // write the nextConfig also to localPersist
                        localPersistDeploy(nextConfig, c)
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
        if (nextConfig && !newSettingsSavedInDb) {
            // const cp = path.join(c.migrationsPath, 'config.json')
            // if (lastConfig) {
            //     fs.writeFileSync(cp, JSON.stringify(lastConfig, null, 2))
            // } else if(fs.existsSync(cp)) {
            //     fs.unlinkSync(cp)
            // }
            if(c.isLocal){
                c.logger.warn('Reverting config.json due to error')
                localPersistDeploy(lastConfig, c)
            }
        }
        throw e
    }
}
