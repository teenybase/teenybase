import generated from './generated.json'
import {DatabaseSettings} from '../../../src'
import {applyMigrations} from '../apply-migrations'

// to regenerate config, see ../../generateMigrations.test.ts
export async function setup(){
    await applyMigrations([...generated.migrations, {
        name: '1000_Fill_Dummy_Data.sql',
        sql: dummyData
    }])
    return generated.config satisfies DatabaseSettings
}

export const dummyData = `
INSERT INTO drive_config (id, val) VALUES
    ('app-name', 'Drive'),
    ('logo', ''),
    ('favicon', ''),
    ('api-version', 'v1'),
    ('language', 'en-US'),
    ('plan', '{"name":"Free","storage-limit-mb":10000,}'),
    ('metadata', '{"password":"secret-0"}');

INSERT INTO drive_config (id, val, protected) VALUES
    ('secret-0', 'khdgx238ewgxjcxiwdbcwe8gc', TRUE),
    ('secret-1', 'be8dg2393uwqnxqoug21z7', TRUE);
`
