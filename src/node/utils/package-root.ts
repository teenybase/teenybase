import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

/**
 * Root directory of the installed teenybase package that this CLI code is running from
 * (found by walking up from this module to the nearest package.json named "teenybase").
 */
export function findTeenybasePackageRoot(): string {
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

/** `version` from the running CLI's own package.json, read at runtime. */
export function readTeenybasePackageVersion(): string {
    const pkgPath = path.join(findTeenybasePackageRoot(), 'package.json')
    const version = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version
    if (typeof version !== 'string' || !version) throw new Error(`No "version" in ${pkgPath}`)
    return version
}
