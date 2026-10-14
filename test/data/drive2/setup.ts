import {config, migrations} from './generated.json'
import {applyMigrations, setupConfig} from '../apply-migrations'
import {passwordProcessors} from '../../../src/worker/util/passwordProcessors'

// to regenerate config, see ../../generateMigrations.test.ts
export async function setup() {
    await applyMigrations([...migrations, {
        name: '20000_Fill_Dummy_Data.sql',
        sql: await dummyData()
    }])
    return await setupConfig(config)
}

export const dummyData = async () => {
    const pass = await passwordProcessors.sha256.hash('password123', 'salt')

    return `
        INSERT INTO drive_config (id, val)
        VALUES ('app-name', 'Drive'),
               ('logo', ''),
               ('favicon', ''),
               ('api-version', 'v1'),
               ('language', 'en-US'),
               ('plan', '{"name":"Free","storage-limit-mb":10000,}'),
               ('metadata', '{"password":"secret-0"}');

        INSERT INTO drive_config (id, val, protected)
        VALUES ('secret-0', 'khdgx238ewgxjcxiwdbcwe8gc', TRUE),
               ('secret-1', 'be8dg2393uwqnxqoug21z7', TRUE);

        INSERT INTO users (id, username, email, email_verified, password, password_salt, name, role, meta)
        VALUES ('suadmin', 'suadmin', 'admin@admin.com', true, '${pass}', 'salt', 'Admin', 'superadmin', '{"base":"/"}');

        INSERT INTO files (id, path, name, file)
        VALUES ('test', '/test/', 'Test File', 'test.txt');
    `
}
