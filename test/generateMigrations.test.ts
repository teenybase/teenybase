import {describe, expect, test} from 'vitest'
import {generateMigrations} from '../src/sql/schema/generateMigrations'
import * as fs from 'node:fs'
import path from 'node:path'
import {loadConfigFromFile} from '../src/node/config'

const basePath = 'test/data/'
const regenerateJsons = false

async function testFn(test: string) {
    const testPath = path.join(basePath, test)
    const config = await loadConfigFromFile(testPath, undefined, 'debug')
    const res = generateMigrations(config.config, undefined)
    const generatedPath = path.join(testPath, 'generated.json')
    if (!fs.existsSync(generatedPath)) {
        fs.writeFileSync(generatedPath, JSON.stringify(res, null, 2))
        throw new Error(`Generated file written to${generatedPath}. check and commit to git.`)
    }
    const generated = JSON.parse(fs.readFileSync(generatedPath, 'utf-8'))
    try {
        expect(res).toEqual(generated)
    }catch (e){
        if(regenerateJsons){
            fs.writeFileSync(generatedPath, JSON.stringify(res, null, 2))
            console.error(`Generated file written to${generatedPath}. check and commit to git.`)
        }
        throw e
    }
    const compareRes = generateMigrations(config.config, generated.config)
    expect(compareRes.migrations.length).toEqual(0)

}

describe('generateMigrations', () => {
    // the script should be run from root dir(with package.json)
    expect(import.meta.dirname).toEqual(path.join(process.cwd(), 'test'))

    test('test1', async ()=>await testFn('test1'))
    test('drive1', async ()=>await testFn('drive1'))
    test('drive2', async ()=>await testFn('drive2'))
})
