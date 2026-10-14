import { splitSqlQuery } from '../../src/worker/wrangler/d1/splitter'
import {applyD1Migrations, D1Migration, env, SELF} from 'cloudflare:test'
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
    //     name: '20000_Fill_Dummy_Data.sql',
    //     queries: splitSqlQuery(dummyData)
    // })
    await applyD1Migrations(env.PRIMARY_DB, migrations);
}

export async function setupConfig<T extends any>(config: T): Promise<T>{
    const config2 = structuredClone(config)
    const headers = {
        '$DB_TEST_DATABASE_SETTINGS': JSON.stringify(config2),
        'Authorization': `Bearer ${'test_admin_service_token'}`, // defined in vitest.config.ts
    } as Record<string, string>

    const res = await SELF.fetch('https://example.com/api/v1/setup-db', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: {
            'Content-Type': 'application/json',
            ...headers
        }
    })
    if (!res.ok) {
        throw new Error(`Failed to setup DB: ${res.status} ${await res.text()}`)
    }else {
        console.log(`Database setup completed: ${res.status} ${await res.text()}`)
    }
    return config2 as T
}
