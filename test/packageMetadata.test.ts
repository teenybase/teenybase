import {describe, expect, it} from 'vitest'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'))

describe('package metadata', () => {
    const pkg = readJson('package.json')

    it('plugin.json version matches package.json', () => {
        expect(readJson('.claude-plugin/plugin.json').version).toBe(pkg.version)
    })

    it('has a real npm description (npm otherwise falls back to the README first line)', () => {
        expect(typeof pkg.description).toBe('string')
        expect(pkg.description).not.toMatch(/^</)
    })

    it('publishes only the core skills', () => {
        const skills = (pkg.files as string[]).filter(f => f.startsWith('skills'))
        expect(skills).not.toContain('skills')
        expect(skills.sort()).toEqual(['skills/teeny-config', 'skills/teeny-migrate', 'skills/teeny-rules', 'skills/teenybase'])
    })
})
