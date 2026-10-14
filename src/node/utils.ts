import * as fs from 'fs'
import path from 'path'
import {Logger} from './logger'

export const isWindows =
    typeof process !== 'undefined' && process.platform === 'win32'

const windowsSlashRE = /\\/g
export function slash(p: string): string {
    return p.replace(windowsSlashRE, '/')
}

export function tryStatSync(file: string): fs.Stats | undefined {
    try {
        // The "throwIfNoEntry" is a performance optimization for cases where the file does not exist
        return fs.statSync(file, { throwIfNoEntry: false })
    } catch {
        // Ignore errors
    }
}

export function findNearestNodeModules(basedir: string): string | null {
    while (basedir) {
        const pkgPath = path.join(basedir, 'node_modules')
        if (tryStatSync(pkgPath)?.isDirectory()) {
            return pkgPath
        }

        const nextBasedir = path.dirname(basedir)
        if (nextBasedir === basedir) break
        basedir = nextBasedir
    }

    return null
}

export function isObject(value: unknown): value is Record<string, any> {
    return Object.prototype.toString.call(value) === '[object Object]'
}

export function normalizePath(id: string): string {
    return path.posix.normalize(isWindows ? slash(id) : id)
}

/**
 * Get a human-readable path, relative to process.cwd(), prefixed with ./ if
 * in a nested subdirectory, to aid with readability.
 * Only used for logging e.g. `Loading DB at ${readableRelative(dbPath)}`:
 *
 * E.g. (assuming process.cwd() is /pwd)
 *
 *	readableRelative('/pwd/wrangler.toml') => 'wrangler.toml'
 *	readableRelative('/wrangler.toml') => '../wrangler.toml'
 *	readableRelative('/pwd/subdir/wrangler.toml') => './subdir/wrangler.toml'
 *
 * */
export function readableRelative(to: string) {
    const relativePath = path.relative(process.cwd(), to);
    if (
        // No directory nesting, return as-is
        path.basename(relativePath) === relativePath ||
        // Outside current directory
        relativePath.startsWith(".")
    ) {
        return relativePath;
    } else {
        return "./" + relativePath;
    }
}

export function escapeRegExp(string: string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}
export function escapeReplacement(string: string) {
    return string.replace(/\$/g, '$$$$');
}

/** Extract a readable error message from any thrown value. Never returns "undefined" or "[object Object]". */
export function getErrorMessage(e: any): string {
    if (typeof e === 'string') return e
    return e?.message || e?.stderr || e?.stdout || e?.output || (typeof e === 'object' ? JSON.stringify(e) : String(e)) || 'unknown error'
}

export function safeJSONParse(json?: string, logger?: Logger): any {
    try {
        return json ? JSON.parse(json) : null;
    } catch {
        logger?.warn(`Failed to parse JSON: ${json}`);
        return null;
    }
}
