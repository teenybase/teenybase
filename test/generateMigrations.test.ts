import {describe, expect, test} from 'vitest'
import {generateMigrations} from '../src/sql/schema/generateMigrations'
import * as fs from 'node:fs'
import path from 'node:path'
import {loadConfigFromFile} from '../src/node/config'

const basePath = 'test/data/'
const regenerateJsons = true

// saving as .json.ts and not .json because - https://github.com/microsoft/TypeScript/issues/26552, https://github.com/microsoft/TypeScript/issues/32063
async function testFn(test: string) {
    const testPath = path.join(basePath, test)
    const config = await loadConfigFromFile(testPath, undefined, 'debug')
    const res = generateMigrations(config.config, undefined)
    const generatedPath = path.join(testPath, 'generated.json.ts')
    const generatedText = `import {DatabaseSettings} from '../../../src'
export const migrations = ${JSON.stringify(res.migrations, null, 2)}
export const config = ${JSON.stringify(res.config, null, 2)} as const satisfies DatabaseSettings\n`
    if (!fs.existsSync(generatedPath)) {
        fs.writeFileSync(generatedPath, generatedText)
        throw new Error(`Generated file written to${generatedPath}. check and commit to git.`)
    }
    const generated = fs.readFileSync(generatedPath, 'utf-8')
    try {
        expect(generatedText).toEqual(generated)
    }catch (e){
        if(regenerateJsons){
            fs.writeFileSync(generatedPath, generatedText)
            console.error(`Generated file written to${generatedPath}. check and commit to git.`)
        }
        throw e
    }
    const lastJSON = generated.split('export const config = ')[1].split(' as const satisfies DatabaseSettings')[0]
    const compareRes = generateMigrations(config.config, JSON.parse(lastJSON))
    expect(compareRes.migrations.length).toEqual(0)

}

describe('generateMigrations', () => {
    // the script should be run from root dir(with package.json)
    expect(import.meta.dirname).toEqual(path.join(process.cwd(), 'test'))

    test('test1', async ()=>await testFn('test1'))
    test('drive1', async ()=>await testFn('drive1'))
    test('drive2', async ()=>await testFn('drive2'))
})

describe('generateMigrations errors test', () => {
    // the script should be run from root dir(with package.json)
    test('empty settings', async ()=>{
        try{
            generateMigrations({} as any, undefined, 0)
        }catch (e) {
            expect(e).toBeInstanceOf(Error)
            expect((e as Error).message.trim()).toEqual(`
Error validating database settings change:
Validation errors:
  - settings → tables: Invalid input: expected array, received undefined
  - settings → jwtSecret: Invalid input: expected string, received undefined
  - settings → appUrl: Invalid input: expected string, received undefined
            `.trim())
        }
    })

        // todo test other errors
})
