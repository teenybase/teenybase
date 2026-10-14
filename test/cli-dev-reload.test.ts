/**
 * `teeny dev` keeps the worker's config snapshot in sync with .local-persist/config.json.
 *
 * The dev worker is bundled from `.teeny/.tmp.config.dev.json` (`virtual:teenybase`). `deploy --local`
 * rewrites .local-persist/config.json after applying migrations, often through the running dev
 * server; `teeny dev` must then rewrite the snapshot so wrangler reloads the worker with the new
 * tables (wrangler watches the snapshot because it is part of the bundle).
 *
 * wrangler is replaced by a stand-in in the temp project (the CLI runs the project's own wrangler
 * first), so this checks the CLI side deterministically without starting workerd. The HTTP side
 * (new table answers 200 without a restart) is covered by the packed-path check.
 */
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {execFileSync, spawn, spawnSync, type ChildProcess} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const teenyBin = path.join(repoRoot, 'bin', 'teeny.js')

let projectDir: string
let devProcess: ChildProcess | undefined
let devLog = ''

const env = () => ({...process.env, FORCE_COLOR: '0', CLOUDFLARE_API_BASE_URL: '', CLOUDFLARE_API_TOKEN: ''})

function teeny(args: string[]) {
    const res = spawnSync(process.execPath, [teenyBin, ...args], {cwd: projectDir, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000})
    if (res.status !== 0) throw new Error(`teeny ${args.join(' ')} exited ${res.status}\n${res.stdout}\n${res.stderr}`)
    return res.stdout
}

const table = (name: string) => `{
        name: '${name}',
        autoSetUid: true,
        fields: [...baseFields, {name: 'title', type: 'text', sqlType: 'text'}],
        extensions: [{name: 'rules', listRule: 'true', viewRule: 'true', createRule: 'true', updateRule: 'true', deleteRule: 'true'} as TableRulesExtensionData],
    }`

/** Write teenybase.ts with these tables and store its resolved settings the way `deploy --local` does. */
function applyLocalConfig(tables: string[]) {
    fs.writeFileSync(path.join(projectDir, 'teenybase.ts'), `import {DatabaseSettings, TableRulesExtensionData} from 'teenybase'
import {baseFields} from 'teenybase/scaffolds/fields'

export default {
    appUrl: 'http://localhost:8787',
    jwtSecret: '$JWT_SECRET',
    tables: [${tables.map(table).join(', ')}],
} satisfies DatabaseSettings
`)
    writeLocalConfigRaw(teeny(['inspect']))
}

function writeLocalConfigRaw(content: string) {
    const configPath = path.join(projectDir, '.local-persist', 'config.json')
    fs.mkdirSync(path.dirname(configPath), {recursive: true})
    const tmp = configPath + '.test.tmp'
    fs.writeFileSync(tmp, content)
    fs.renameSync(tmp, configPath)
}

const snapshotPath = () => path.join(projectDir, '.teeny', '.tmp.config.dev.json')
const snapshotTables = () => (JSON.parse(fs.readFileSync(snapshotPath(), 'utf8')).tables as {name: string}[]).map(t => t.name)

async function waitFor(check: () => boolean, timeoutMs: number, what: string) {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
        try {
            if (check()) return
        } catch { /* not there yet */ }
        await new Promise(r => setTimeout(r, 200))
    }
    throw new Error(`Timed out waiting for ${what}\n--- dev output ---\n${devLog.slice(-4000)}`)
}

/** Stand-in for `wrangler dev`: reports its args and stays up until interrupted. */
const fakeWrangler = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] !== 'dev') { console.error('fake wrangler: unsupported ' + args.join(' ')); process.exit(2) }
console.log('fake wrangler dev ready ' + JSON.stringify(args))
const stop = () => process.exit(0)
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
setInterval(() => {}, 1000)
`

describe('teeny dev follows deploy --local', () => {
    beforeAll(() => {
        execFileSync('npm', ['run', 'js-node'], {cwd: repoRoot, stdio: 'pipe', shell: process.platform === 'win32'})
        projectDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'teeny-dev-reload-'))
        teeny(['init', '--yes', '--no-install', '--template', 'blank'])
        const modules = path.join(projectDir, 'node_modules')
        fs.mkdirSync(modules, {recursive: true})
        // teenybase.ts imports 'teenybase' (bundled by the config loader); link this repo.
        fs.symlinkSync(repoRoot, path.join(modules, 'teenybase'), process.platform === 'win32' ? 'junction' : 'dir')
        fs.mkdirSync(path.join(modules, 'wrangler', 'bin'), {recursive: true})
        fs.writeFileSync(path.join(modules, 'wrangler', 'package.json'), JSON.stringify({name: 'wrangler', version: '0.0.0-test', bin: {wrangler: 'bin/wrangler.js'}}))
        fs.writeFileSync(path.join(modules, 'wrangler', 'bin', 'wrangler.js'), fakeWrangler)
        applyLocalConfig(['items'])
    }, 180_000)

    afterAll(async () => {
        if (devProcess && devProcess.exitCode === null) {
            devProcess.kill('SIGINT')
            await new Promise<void>(resolve => {
                devProcess!.once('exit', () => resolve())
                setTimeout(resolve, 10_000)
            })
        }
        if (projectDir) fs.rmSync(projectDir, {recursive: true, force: true})
    })

    it('rewrites the dev config snapshot when .local-persist/config.json changes', async () => {
        devProcess = spawn(process.execPath, [teenyBin, 'dev'], {cwd: projectDir, env: env(), stdio: ['ignore', 'pipe', 'pipe']})
        devProcess.stdout!.on('data', d => { devLog += d })
        devProcess.stderr!.on('data', d => { devLog += d })

        await waitFor(() => devLog.includes('fake wrangler dev ready') && fs.existsSync(snapshotPath()), 60_000, 'teeny dev to start')
        expect(snapshotTables()).toEqual(['items'])

        applyLocalConfig(['items', 'notes'])
        await waitFor(() => snapshotTables().includes('notes'), 10_000, 'the snapshot to include "notes"')
        expect(snapshotTables()).toEqual(['items', 'notes'])
        expect(devLog).toContain('reloading the dev server')
    }, 120_000)

    it('ignores an invalid config and keeps serving the last good one', async () => {
        writeLocalConfigRaw('{"tables": "not an array"}')
        await waitFor(() => devLog.includes('Ignoring the changed'), 10_000, 'the invalid config to be reported')
        expect(snapshotTables()).toEqual(['items', 'notes'])
        expect(devProcess!.exitCode).toBeNull()
    }, 30_000)

    it('removes the snapshot when dev stops', async () => {
        devProcess!.kill('SIGINT')
        await new Promise<void>(resolve => devProcess!.once('exit', () => resolve()))
        expect(fs.existsSync(snapshotPath())).toBe(false)
    }, 30_000)
})
