import {describe, expect, it} from 'vitest'
import {z} from 'zod'
import {DatabaseSettings, tableAuthDataSchema, TableAuthExtensionData, validateSettingsChange} from '../src'
import {config} from './data/drive2/generated.json'

// `emailTemplates.<template>.tags` used to be typed and validated as a string while every email
// flow spreads it into the tag list (`[..., ...(template.tags || [])]` in tableAuthExtension), so
// `tags: 'verification'` validated and then went out as one tag per character
// ('v', 'e', 'r', ...). It is a string[] now, like `email.tags`.
//
// Extension data is validated in two places: `validateSettingsChange` (generate / migrate / deploy)
// and `tableAuthDataSchema` when the auth extension is constructed at runtime. Both are checked.

function settingsWithTemplateTags(tags: unknown) {
    const settings = structuredClone(config) as any
    const auth = settings.tables.find((t: any) => t.name === 'users').extensions.find((e: any) => e.name === 'auth')
    auth.emailTemplates = {verification: {subject: 'Verify', tags}, passwordReset: {tags}}
    return {settings: settings as DatabaseSettings, auth}
}

function settingsIssues(tags: unknown): string[] {
    try {
        validateSettingsChange(settingsWithTemplateTags(tags).settings, undefined)
        return []
    } catch (e) {
        if (!(e instanceof z.ZodError)) throw e
        return e.issues.map(i => i.path.join('.'))
    }
}

describe('auth emailTemplates tags', () => {
    it('accepts an array of strings and keeps it as an array', () => {
        expect(settingsIssues(['welcome', 'v2'])).toEqual([])
        const parsed = tableAuthDataSchema.parse(settingsWithTemplateTags(['welcome', 'v2']).auth)
        expect(parsed.emailTemplates?.verification?.tags).toEqual(['welcome', 'v2'])
        expect(parsed.emailTemplates?.passwordReset?.tags).toEqual(['welcome', 'v2'])
    })

    it('rejects a string, naming the field', () => {
        const paths = settingsIssues('verification')
        expect(paths.some(p => p.endsWith('emailTemplates.verification.tags'))).toBe(true)
        expect(paths.some(p => p.endsWith('emailTemplates.passwordReset.tags'))).toBe(true)
        expect(tableAuthDataSchema.safeParse(settingsWithTemplateTags('verification').auth).success).toBe(false)
    })

    it('rejects non-string entries', () => {
        expect(settingsIssues(['ok', 1])).not.toEqual([])
        expect(tableAuthDataSchema.safeParse(settingsWithTemplateTags(['ok', 1]).auth).success).toBe(false)
    })

    it('is typed as string[]', () => {
        const ok: TableAuthExtensionData['emailTemplates'] = {verification: {tags: ['a']}}
        // @ts-expect-error a single string is not a tag list
        const bad: TableAuthExtensionData['emailTemplates'] = {verification: {tags: 'a'}}
        expect([ok, bad]).toHaveLength(2)
    })
})
