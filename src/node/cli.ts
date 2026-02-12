// import { performance } from 'perf_hooks'
import {cac} from 'cac'
import colors from 'picocolors'
import prompts from 'prompts'
import {VERSION} from './constants'
import {createLogger, Logger, LogLevel} from './logger'
import * as fs from 'node:fs'
import path from 'path'
import {escapeRegExp, normalizePath, readableRelative} from './utils'
import {execSync} from 'node:child_process'
import {exportLocal} from './wrangler/export'
import {
    CliContext, deploySecrets, devVars, fetchDeployedMigrations, fetchWorker,
    filterDuplicateOptions,
    generateMigrationsDir,
    GlobalCLIOptions, loadLocalPersistConfig,
    migrateAndDeploy,
    parseWrangler, prodVars, readSecretsFile
} from './cli-utils'

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
    .option(
        '-y, --yes',
        `[boolean] skip confirmation prompts (default: false)`,
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
            const skipConfirm = Boolean(options.y || options.yes)
            await migrateAndDeploy(c, clean, doMigrate, forceDeploy, skipConfirm).catch(async e=>{
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
    .option(
        '-y, --yes',
        `[boolean] skip confirmation prompts (default: false)`,
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
            const skipConfirm = Boolean(options.y || options.yes)
            await migrateAndDeploy(c, clean, doMigrate, forceDeploy, skipConfirm).catch(async e=>{
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

            const message = `About to upload(create/replace) ${secretKeys.length} secrets to the worker ${workerName} in cloudflare account ${cfAccountId}?\nMake sure 'wrangler login' has been run before continuing. \nThis will run 'wrangler secret bulk'. Do you want to continue? `
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

                const command = `npx wrangler dev \
                --persist-to=${JSON.stringify(c.localPersistPath)} \
                --port=${c.devServerPort} \
                --tsconfig=${JSON.stringify(c.createCustomTsconfigForWorker('dev'))}
                `
                // ${c.isLocal ? '--local' : '--remote'} \

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
                c.removeCustomTsconfig('dev')
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

                loadLocalPersistConfig(c)

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
                const res = c.buildLocal(outDir, true, true, false, '--minify')
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
