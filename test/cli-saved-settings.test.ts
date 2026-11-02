import {describe, expect, it} from 'vitest'
import {parseSavedSettings} from '../src/node/cli-utils'
import {databaseSettingsSchema} from '../src/types/zod/databaseSettingsSchema'
import config from './data/drive2/teeny.config'

// Settings saved by an earlier deploy are read with the current schema to work out the migrations.
describe('parseSavedSettings', () => {
    const saved = (extra: Record<string, unknown>) => JSON.parse(JSON.stringify({...databaseSettingsSchema.parse(config), ...extra}))

    it('reads settings that pass the current schema as the schema parses them', () => {
        const s = saved({})
        expect(parseSavedSettings(s)).toEqual(databaseSettingsSchema.parse(s))
    })

    it('keeps issuers saved without clientId (valid before 0.1.1) and parses the rest', () => {
        const authProviders = [{issuer: 'https://idp.example.com', secret: 'ext-shared-secret-0123456789', algorithm: 'HS256'}]
        const jwtAllowedIssuers = ['https://idp.example.com']
        const s = saved({authProviders, jwtAllowedIssuers})
        expect(databaseSettingsSchema.safeParse(s).success).toBe(false)
        const res = parseSavedSettings(s)
        expect(res.authProviders).toEqual(authProviders)
        expect(res.jwtAllowedIssuers).toEqual(jwtAllowedIssuers)
        expect(res.tables).toEqual(databaseSettingsSchema.parse(saved({})).tables)
    })

    it('still fails on any other invalid key', () => {
        const s = saved({authProviders: [{issuer: 'https://idp.example.com', secret: 'x'}]})
        s.tables[0].name = ''
        expect(() => parseSavedSettings(s)).toThrow()
    })
})
