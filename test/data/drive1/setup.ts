import {config, migrations} from './generated.json'
import {applyMigrations, setupConfig} from '../apply-migrations'

// to regenerate config, see ../../generateMigrations.test.ts
export async function setup(){
    await applyMigrations(migrations)
    return await setupConfig(config)
}
