import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'

/**
 * Absolute path of the wrangler CLI entry script (`bin.wrangler` in wrangler's package.json).
 *
 * Wrangler is run as `node <entry> ...args` instead of `npx wrangler ...args`:
 * - On Windows `npx` is `npx.cmd`. Node can't spawn `.cmd` files without a shell
 *   (EINVAL since the CVE-2024-27980 fix), so `spawn('npx', ...)` fails there.
 * - `shell: true` doesn't fix it safely. Node concatenates the args into one command line
 *   without escaping, which breaks args that contain spaces, quotes or parentheses
 *   (project paths, the SQL passed to `d1 execute --command=`).
 * Spawning the current node binary with the JS entry needs no shell on any platform.
 *
 * Lookup order matches what `npx wrangler` run in `root` would pick: the project's own wrangler
 * first (node_modules of `root` and its parents), then the wrangler that teenybase depends on.
 */
export function resolveWranglerBin(root: string): string {
    return resolveWranglerPackage(root).bin
}

/** The wrangler package {@link resolveWranglerBin} picks: its CLI entry script and its version. */
export function resolveWranglerPackage(root: string): {bin: string, version: string} {
    const bases = [path.join(root, 'package.json'), import.meta.url]
    for (const base of bases) {
        let pkgPath: string
        try {
            pkgPath = createRequire(base).resolve('wrangler/package.json')
        } catch (e: any) {
            if (e?.code === 'MODULE_NOT_FOUND') continue
            throw e
        }
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.wrangler
        if (!bin) throw new Error(`wrangler package at ${path.dirname(pkgPath)} has no "wrangler" bin entry`)
        return {bin: path.resolve(path.dirname(pkgPath), bin), version: String(pkg.version ?? '')}
    }
    throw new Error('Could not find the wrangler package. Run "npm install" in the project directory.')
}
