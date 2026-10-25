import {beforeAll, describe, expect, it} from 'vitest'
import {execFileSync, spawnSync} from 'node:child_process'
import path from 'node:path'

import {fileURLToPath} from 'node:url'
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const teenyBin = path.join(repoRoot, 'bin', 'teeny.js')
const configRoot = path.join(repoRoot, 'test', 'data', 'test1')
const baseEnv = {
    ...process.env,
    FORCE_COLOR: '0',
}

function runTeeny(args: string[]) {
    return spawnSync('node', [teenyBin, ...args], {
        cwd: repoRoot,
        env: baseEnv,
        encoding: 'utf8',
    })
}

describe('CLI utility commands', () => {
    beforeAll(() => {
        execFileSync('npm', ['run', 'js-node'], {
            cwd: repoRoot,
            env: baseEnv,
            stdio: 'pipe',
        })
    })

    it('lists docs and skills in top-level help output', () => {
        const res = runTeeny(['--help'])
        expect(res.status).toBe(0)
        const plain = res.stdout.replace(/\u001b\[\d+m/g, '')
        expect(plain).toMatch(/docs\s+read docs if you're new to Teenybase/)
        expect(plain).toMatch(/skills\s+check available Teeny skills before doing complex workflows/)
    })

    it('has no hosted-platform commands', () => {
        const res = runTeeny(['--help'])
        expect(res.status).toBe(0)
        const plain = res.stdout.replace(/\u001b\[\d+m/g, '')
        const commands = [...plain.matchAll(/^ {2}(\S+)/gm)].map(m => m[1])
        expect(commands).toContain('deploy')
        expect(commands).toContain('logs')
        for (const removed of ['register', 'login', 'logout', 'whoami', 'list', 'status', 'delete']) {
            expect(commands).not.toContain(removed)
        }
        expect(plain).not.toMatch(/Teenybase Cloud|--server/)
    })

    it('prints each skill with the first sentence of its SKILL.md description', () => {
        const res = runTeeny(['skills'])
        expect(res.status).toBe(0)
        for (const name of ['teenybase', 'teeny-rules', 'teeny-migrate']) {
            expect(res.stdout).toContain(path.join(repoRoot, 'skills', name))
        }
        expect(res.stdout).toContain('Build, change and deploy a Teenybase backend on Cloudflare Workers + D1, defined in one teenybase.ts file: tables, fields, auth, access rules, actions, generated migrations, local dev and deploys.')
        expect(res.stdout).not.toContain('teeny-config')
    })

    it('lists package documentation files from the installed docs directory', () => {
        const res = runTeeny(['docs'])
        expect(res.status).toBe(0)
        expect(res.stdout).toContain(path.join(repoRoot, 'docs'))
        expect(res.stdout).toContain('cli.md')
    })

    it('keeps inspect JSON on stdout when validation succeeds', () => {
        const res = runTeeny(['inspect', '--root', configRoot, '--table', 'users', '--validate'])
        expect(res.status).toBe(0)
        expect(res.stdout).not.toContain('Config is valid')
        expect(res.stderr).toContain('Config is valid')

        const output = JSON.parse(res.stdout)
        expect(output.name).toBe('users')
    })
})
