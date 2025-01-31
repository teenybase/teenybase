import {config, migrations} from './generated.json'
import {applyMigrations} from '../apply-migrations'

// to regenerate config, see ../../generateMigrations.test.ts
export async function setup(){
    await applyMigrations(migrations)
    return structuredClone(config)
}
