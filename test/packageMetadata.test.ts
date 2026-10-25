import {describe, expect, it} from 'vitest'
import fs, {readFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'))

describe('package metadata', () => {
    const pkg = readJson('package.json')

    it('plugin.json version matches package.json', () => {
        expect(readJson('plugin/.claude-plugin/plugin.json').version).toBe(pkg.version)
    })

    it('has a real npm description (npm otherwise falls back to the README first line)', () => {
        expect(typeof pkg.description).toBe('string')
        expect(pkg.description).not.toMatch(/^</)
    })

    it('publishes only the core skills, from the plugin folder', () => {
        // the Claude Code plugin is plugin/ (marketplace source ./plugin), so an install copies only it
        expect(pkg.files).toContain('plugin')
        expect((pkg.files as string[]).filter(f => f.startsWith('skills'))).toEqual([])
        const skills = fs.readdirSync(path.join(root, 'plugin', 'skills')).sort()
        expect(skills).toEqual(['teeny-migrate', 'teeny-rules', 'teenybase'])
        expect(readJson('.claude-plugin/marketplace.json').plugins[0].source).toBe('./plugin')
    })
})

describe('pinned UI assets', () => {
    it('loads exact versions of the admin panel and Swagger UI, never latest', async () => {
        const {POCKET_UI_VERSION, PocketUIExtension} = await import('../src/worker/util/pocketui')
        const {SWAGGER_UI_VERSION} = await import('../src/worker/util/openapi')
        expect(POCKET_UI_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
        expect(SWAGGER_UI_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
        expect(new PocketUIExtension({} as any).uiVersion).toBe(POCKET_UI_VERSION)
    })
})
