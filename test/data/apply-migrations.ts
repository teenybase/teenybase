import splitSqlQuery from '../../src/worker/wrangler/d1/splitter'
import {applyD1Migrations, D1Migration, env} from 'cloudflare:test'
import {DBMigration} from '../../src/worker/migrationHelper'

export async function applyMigrations(generated: Pick<DBMigration, 'name'|'sql'>[]){
    // to be called from beforeAll
    // Setup files run outside isolated storage, and may be run multiple times.
    // `applyD1Migrations()` only applies migrations that haven't already been
    // applied, therefore it is safe to call this function here.
    const migrations = generated.map(m=>{
        return {
            name: m.name,
            queries: splitSqlQuery(m.sql)
        } as D1Migration
    })
    // migrations.push({
    //     name: '1000_Fill_Dummy_Data.sql',
    //     queries: splitSqlQuery(dummyData)
    // })
    await applyD1Migrations(env.PRIMARY_DB, migrations);
}
