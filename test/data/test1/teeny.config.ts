import {DatabaseSettings, sql, TableRulesExtensionData} from '../../../src'

export default {
    appUrl: "https://localhost",
    jwtSecret: 'asdadqdihxwdsuhcwhc0cwe8hnwcw',
    tables: [
        {
            name: 'users',
            r2Base: 'users',
            autoSetUid: false,
            allowWildcard: false,
            fields: [{
                name: 'id', sqlType: 'integer', type: 'integer', usage: 'record_uid',
                primary: true, noUpdate: true, noInsert: true, autoIncrement: true,
            }, {
                name: 'name', sqlType: 'text', type: 'text', notNull: true,
            }, {
                name: 'email', sqlType: 'text', type: 'email', notNull: true, unique: true
            }, {
                name: 'uid', sqlType: 'text', type: 'text', notNull: true, unique: true,
            }, {
                name: 'pass_hash', sqlType: 'text', type: 'text', notNull: true
            }, {
                name: 'created', sqlType: 'timestamp', type: 'date', usage: 'record_created',
                default: sql`CURRENT_TIMESTAMP`, noInsert: true, noUpdate: true,
            }, {
                name: 'updated', sqlType: 'timestamp', type: 'date', usage: 'record_updated',
                default: sql`CURRENT_TIMESTAMP`, noInsert: true, noUpdate: true,
            },
            ],
            triggers: [{
                name: "raise_on_created_update",
                seq: "BEFORE",
                event: "UPDATE",
                updateOf: "created",
                body: sql`SELECT RAISE(FAIL, 'Cannot update created column') WHERE OLD.created != NEW.created`,
            }, {
                name: "update_updated_on_update",
                seq: "AFTER",
                event: "UPDATE",
                body: sql`UPDATE users SET updated = CURRENT_TIMESTAMP WHERE id = NEW.id AND OLD.updated = NEW.updated`,
            }],
            indexes: [{
                fields: "name",
            }],
            extensions: [{
                name: "rules",
                listRule: 'true',
                viewRule: 'true',
                createRule: 'true',
                updateRule: 'true',
                deleteRule: 'true',
            } as TableRulesExtensionData]
        },
        {
            name: 'files',
            r2Base: 'files',
            autoSetUid: false,
            fields: [{
                name: 'id', sqlType: 'integer', type: 'integer', usage: 'record_uid',
                primary: true, noUpdate: true, noInsert: true, autoIncrement: true,
            }, {
                name: 'name', sqlType: 'text', type: 'text', notNull: true
            }, {
                name: 'url', sqlType: 'text', type: 'url', notNull: true
            }, {
                name: 'metadata', sqlType: 'json', type: 'json',
                check: sql`json_valid(metadata)`
            }, {
                name: 'user_id', sqlType: 'integer', type: 'relation',
                foreignKey: {table: 'users', column: 'id', onDelete: 'CASCADE'}
            }, {
                name: 'created', sqlType: 'timestamp', type: 'date', usage: 'record_created',
                default: sql`CURRENT_TIMESTAMP`, noInsert: true, noUpdate: true,
            },],
            indexes: [{
                fields: "name",
            },{
                fields: "user_id",
            }],
            extensions: [{
                name: "rules",
                listRule: 'true',
                viewRule: 'true',
                createRule: 'true',
                updateRule: 'true',
                deleteRule: 'true',
            } as TableRulesExtensionData]
        }
    ]
} satisfies DatabaseSettings
