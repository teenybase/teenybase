import path from 'path'
import * as fs from 'fs'
import {pathToFileURL} from 'url'
import * as esbuild from 'esbuild'
import process from 'process'
import {DEFAULT_CONFIG_FILES, DEFAULT_WRANGLER_CONFIG_FILES} from './constants'
import {debug} from 'util'
import {createLogger, Logger, LogLevel} from './logger'
import {findNearestNodeModules, isObject, normalizePath} from './utils'
import colors from 'picocolors'
import {DatabaseSettings} from '../types/config'
import {parseJSONC, parseTOML, readFileSync} from './workers-utils'

async function bundleCode(fileName: string, logLevel?: LogLevel) {
    const options: esbuild.BuildOptions = {
        entryPoints: [fileName],
        bundle: true,
        write: false,
        // resolveExtensions: ['.ts', '.js', '.json'],
        minify: false,
        logLevel: logLevel === 'warn' ? 'warning' : logLevel,
        platform: 'node',
        allowOverwrite: false,
        sourcemap: false,
        format: 'esm',
        target: 'esnext',
        // format: OutputFormat.ESM,
        // mainFields: ['module', 'main'],
        banner: {
            "js": "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
        },
    }
    const built = await esbuild.build(options)
    const bundledCode = built.outputFiles?.[0].text
    if(!bundledCode) throw new Error('Failed to load code - ' + fileName)
    return bundledCode;
}

async function loadConfigFromBundledFile(bundle: string, fileName: string){
    // packages/vite/src/node/config.ts:loadConfigFromBundledFile
    const nodeModulesDir = findNearestNodeModules(path.dirname(fileName))
    if (nodeModulesDir) {
        await fs.promises.mkdir(path.resolve(nodeModulesDir, '.teeny-temp/'), {
            recursive: true,
        })
    }
    const hash = `timestamp-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const tempFileName = nodeModulesDir
        ? path.resolve(
            nodeModulesDir,
            `.teeny-temp/${path.basename(fileName)}.${hash}.mjs`,
        )
        : `${fileName}.${hash}.mjs`
    await fs.promises.writeFile(tempFileName, bundle)
    try {
        return (await import(pathToFileURL(tempFileName).href)).default
    } finally {
        fs.unlink(tempFileName, () => {}) // Ignore errors
    }
}


export async function loadConfigFromFile(
    // configEnv: ConfigEnv,
    configRoot: string,
    configFile?: string,
    logLevel?: LogLevel,
    customLogger?: Logger,
): Promise<{
    path: string
    config: DatabaseSettings
}> {
    const start = performance.now()
    const getTime = () => `${(performance.now() - start).toFixed(2)}ms`

    let resolvedPath: string | undefined

    if (configFile) {
        // explicit config path is always resolved from cwd
        resolvedPath = path.resolve(configFile)
    } else {
        // implicit config file loaded from inline root (if present)
        // otherwise from cwd
        for (const filename of DEFAULT_CONFIG_FILES) {
            const filePath = path.resolve(configRoot, filename)
            if (!fs.existsSync(filePath)) continue

            resolvedPath = filePath
            break
        }
    }

    if (!resolvedPath) {
        // debug?.('no config file found.')
        throw new Error('no config file found.')
        // return null
    }

    try {
        let config: any;

        // Handle JSON/JSONC files directly without bundling
        if (resolvedPath.endsWith('.json') || resolvedPath.endsWith('.jsonc')) {
            config = parseJSONC(readFileSync(resolvedPath), resolvedPath);
        } else {
            // Handle JS/TS files by bundling and executing

            // const isESM =
            //     typeof process.versions.deno === 'string' || isFilePathESM(resolvedPath)
            const isESM = true // todo
            const bundled = await bundleCode(resolvedPath, logLevel)
            const userConfig = await loadConfigFromBundledFile(
                bundled,
                resolvedPath,
            )
            debug?.(`bundled config file loaded in ${getTime()}`)

            config = await (typeof userConfig === 'function'
                ? userConfig()
                : userConfig)
        }

        // todo validate zod
        if (!isObject(config)) {
            throw new Error(`config must export or return an object.`)
        }
        return {
            path: normalizePath(resolvedPath),
            config: config as any,
            // dependencies: bundled.dependencies,
        }
    } catch (e: any) {
        createLogger(logLevel, { customLogger }).error(
            colors.red(`failed to load config from ${resolvedPath}`),
            {error: e},
        )
        throw e
    }
}

// todo use experimental_readRawConfig from wrangler worker utils
export async function loadWranglerConfigFromFile(
    // configEnv: ConfigEnv,
    configRoot: string,
    configFile?: string,
    logLevel?: LogLevel,
    customLogger?: Logger,
): Promise<{
    path: string
    config: any
}> {
    // const start = performance.now()
    // const getTime = () => `${(performance.now() - start).toFixed(2)}ms`

    let resolvedPath: string | undefined

    if (configFile) {
        // explicit config path is always resolved from cwd
        resolvedPath = path.resolve(configFile)
    } else {
        // implicit config file loaded from inline root (if present)
        // otherwise from cwd
        for (const filename of DEFAULT_WRANGLER_CONFIG_FILES) {
            const filePath = path.resolve(configRoot, filename)
            if (!fs.existsSync(filePath)) continue

            resolvedPath = filePath
            break
        }
    }

    if (!resolvedPath) {
        // debug?.('no config file found.')
        throw new Error('no wrangler config file found.')
        // return null
    }

    try {
        let loadedConfig = {}
        if(resolvedPath.endsWith('.json') || resolvedPath.endsWith('.jsonc')){
            loadedConfig = parseJSONC(readFileSync(resolvedPath), resolvedPath) as any;
        }else if(resolvedPath.endsWith('.toml')){
            loadedConfig = parseTOML(readFileSync(resolvedPath), resolvedPath) as any;
        }

        return {
            path: normalizePath(resolvedPath),
            config: loadedConfig,
        }
    } catch (e: any) {
        createLogger(logLevel, { customLogger }).error(
            colors.red(`failed to load config from ${resolvedPath}`),
            {error: e},
        )
        throw e
    }
}
