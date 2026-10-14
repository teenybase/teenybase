import {
    DatabaseSettings,
    sql, sqlValue,
    TableAuthExtensionData,
    TableFieldUsageAuth,
    TableFieldUsageRecord,
    TableRulesExtensionData
} from '../../../src'

export default {
    appUrl: "https://localhost",
    jwtSecret: 'ldhsadiudsadqdxhaoxindgcx79cxha',
    tables: [
        {
            name: 'users',
            r2Base: 'users',
            autoSetUid: true,
            // allowWildcard: false,
            fields: [
                {name: "id", primary: true, type: 'text', sqlType: 'text', notNull: true, usage: TableFieldUsageRecord.record_uid, noUpdate: true},
                // {name: "updated", type: 'date', sqlType: 'timestamp', default: sql`CURRENT_TIMESTAMP`, notNull: true, usage: TableFieldUsageRecord.record_updated, noInsert: true, noUpdate: true},
                {name: 'name', sqlType: 'text', type: 'text', notNull: true, usage: 'auth_name'},
                {name: 'email', sqlType: 'text', type: 'email', notNull: true, unique: true, usage: 'auth_email'},
                {name: 'email_verified', sqlType: 'boolean', type: 'bool', usage: 'auth_email_verified', default: {l:false} },
                {name: "username", type: 'text', sqlType: 'text', notNull: true, unique: true, usage: TableFieldUsageAuth.auth_username},
                {name: "password", type: 'text', sqlType: 'text', notNull: true, usage: TableFieldUsageAuth.auth_password, noSelect: true},
                {name: "created", type: 'date', sqlType: 'timestamp', default: sql`CURRENT_TIMESTAMP`, notNull: true, usage: TableFieldUsageRecord.record_created, noInsert: true, noUpdate: true},
                {name: "role", type: 'text', sqlType: 'text', usage: TableFieldUsageAuth.auth_audience, default: sqlValue('guest')},
                {name: "meta", type: 'json', sqlType: 'json', usage: TableFieldUsageAuth.auth_metadata, default: sqlValue('{}')},
                {name: "avatar", sqlType: 'text', type: 'file', usage: TableFieldUsageAuth.auth_avatar, default: sqlValue(null)},
            ],
            triggers: [{
                name: "raise_on_created_update",
                seq: "BEFORE",
                event: "UPDATE",
                updateOf: ["created"],
                body: sql`SELECT RAISE(FAIL, 'Cannot update created column') WHERE OLD.created != NEW.created`,
            }],
            indexes: [
                {fields: "name"},
                {fields: "role"},
            ],
            extensions: [{
                name: "rules",
                listRule: "auth.uid == id",
                viewRule: "auth.uid == id",
                createRule: "auth.uid == null & role = 'guest'",
                // updateRule: "auth.uid == id & role == new.role & base_path == new.base_path",
                updateRule: null,
                deleteRule: null,
            } as TableRulesExtensionData, {
                name: "auth",
                passwordType: "sha256",
                jwtSecret: "akjbiohxsjapmxu2djsa",
                jwtTokenDuration: 3600,
                maxTokenRefresh: 30,
                passwordCurrentSuffix: "Current",
                passwordConfirmSuffix: "Confirm",
            }as TableAuthExtensionData]
        },
        {
            name: 'files',
            r2Base: 'files',
            autoSetUid: true,
            fields: [
                {name: "id", primary: true, type: 'text', sqlType: 'text', notNull: true, usage: TableFieldUsageRecord.record_uid, noUpdate: true}, {
                name: 'created', sqlType: 'timestamp', type: 'date', usage: 'record_created',
                default: sql`CURRENT_TIMESTAMP`, noInsert: true, noUpdate: true,
            }, {
                name: 'updated', sqlType: 'timestamp', type: 'date', usage: 'record_updated',
                default: sql`CURRENT_TIMESTAMP`, noInsert: true, noUpdate: true,
            }, {name: 'path', sqlType: 'text', type: 'text', notNull: true},
                {name: 'name', sqlType: 'text', type: 'text', notNull: true},
                {name: 'thumb', sqlType: 'text', type: 'file'},
                {name: 'file', sqlType: 'text', type: 'file'},
                {name: 'notes', sqlType: 'text', type: 'text', notNull: true, default: sqlValue('')},
                {name: 'config', sqlType: 'json', type: 'json', check: sql`json_valid(config)`},
                {name: 'meta', sqlType: 'json', type: 'json', check: sql`json_valid(meta)`},
                {name: 'created_by', sqlType: 'text', type: 'relation',
                foreignKey: {table: 'users', column: 'id', onDelete: 'CASCADE'}},
                {name: 'tags', sqlType: 'text', type: 'text'},
                {name: 'deleted_by', sqlType: 'text', type: 'relation',
                    foreignKey: {table: 'users', column: 'id', onDelete: 'SET NULL'}},
                {name: 'deleted_at', sqlType: 'timestamp', type: 'date'},
            ],
            indexes: [
                {fields: "name"},
                {fields: "path"},
                {fields: "tags"},
                {fields: "created_by"},
                {fields: "deleted_by"},
            ],
            triggers: [{
                name: "raise_on_created_update",
                seq: "BEFORE",
                event: "UPDATE",
                updateOf: ["created"],
                body: sql`SELECT RAISE(FAIL, 'Cannot update created column') WHERE OLD.created != NEW.created`,
            }, {
                name: "set_deleted_at_on_delete_by",
                seq: "BEFORE",
                event: "UPDATE",
                updateOf: "deleted_by",
                body: sql`UPDATE files SET deleted_at = CURRENT_TIMESTAMP WHERE id = NEW.id AND OLD.deleted_by IS NULL AND NEW.deleted_by IS NOT NULL`,
            }],
            extensions: [{
                name: "rules",
                listRule: "auth.uid == id",
                viewRule: "auth.uid == id",
                createRule: "auth.uid == null & role = null",
                // updateRule: "auth.uid == id & role == new.role & base_path == new.base_path",
                updateRule: null,
                deleteRule: null,
            } as TableRulesExtensionData]
        }
    ],
    actions: [
        {
            name: 'mark_verified',
            description: 'Mark a user email as verified (test-only)',
            applyTableRules: false,
            params: {email: 'string', id: 'string'},
            sql: {
                type: 'UPDATE',
                table: 'users',
                set: {email_verified: sqlValue(true)},
                where: sql`{:email} LIKE '%@example.com' AND email = {:email} AND email_verified = false AND id = {:id}`,
                returning: ['*'],
            }
        },
        {
            name: 'mark_verified_stat',
            applyTableRules: false,
            requireAuth: true,
            params: {email: 'string'},
            steps: {
                type: 'UPDATE',
                table: 'users',
                setValues: {email_verified: true},
                where: "email = params.email & email_verified = false & email ~ '%@example.com' & id = auth.uid",
            }
        },
        {
            name: 'mark_verified_guarded',
            applyTableRules: false,
            guard: "auth.uid != null",
            params: {email: 'string', id: 'string'},
            sql: {
                type: 'UPDATE',
                table: 'users',
                set: {email_verified: sqlValue(true)},
                where: sql`{:email} LIKE '%@example.com' AND email = {:email} AND email_verified = false AND id = {:id}`,
                returning: ['*'],
            }
        },
    ]
} satisfies DatabaseSettings
