import generated from './generated.json'
import {DatabaseSettings} from '../../../src'
import {applyMigrations} from '../apply-migrations'

// to regenerate config, see ../../generateMigrations.test.ts
export async function setup(){
    await applyMigrations(generated.migrations)
    return generated.config satisfies DatabaseSettings
}
