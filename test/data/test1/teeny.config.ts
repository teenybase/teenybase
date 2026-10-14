import {DatabaseSettings, sql, sqlValue, TableRulesExtensionData} from '../../../src'

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
            },
            {name: 'name', sqlType: 'text', type: 'text', notNull: true,},
            {name: 'email', sqlType: 'text', type: 'email', notNull: true, unique: true},
            {name: 'uid', sqlType: 'text', type: 'text', notNull: true, unique: true,},
            {name: 'pass_hash', sqlType: 'text', type: 'text', notNull: true},
            {
                name: 'created', sqlType: 'timestamp', type: 'date', usage: 'record_created',
                default: sql`CURRENT_TIMESTAMP`, noInsert: true, noUpdate: true,
            }, {
                name: 'updated', sqlType: 'timestamp', type: 'date', usage: 'record_updated',
                default: sql`CURRENT_TIMESTAMP`, noInsert: true, noUpdate: true,
            }],
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
            },
            {name: 'name', sqlType: 'text', type: 'text', notNull: true},
            {name: 'url', sqlType: 'text', type: 'url', notNull: true},
            {
                name: 'metadata', sqlType: 'json', type: 'json',
                check: sql`json_valid(metadata)`
            }, {
                name: 'user_id', sqlType: 'integer', type: 'relation',
                foreignKey: {table: 'users', column: 'id', onDelete: 'CASCADE'}
            }, {
                name: 'created', sqlType: 'timestamp', type: 'date', usage: 'record_created',
                default: sql`CURRENT_TIMESTAMP`, noInsert: true, noUpdate: true,
            },
            {
                name: 'counter', sqlType: 'integer', type: 'integer', notNull: true, default: sqlValue(0), noInsert: true, noUpdate: true},  // can only be updated by procedure
            ],
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
    ],
    actions: [{
        name: 'inc_counter_sql',
        params: {file_id: 'integer'},
        applyTableRules: false,
        sql: [
            {
                type: 'UPDATE',
                table: 'files',
                set: {
                    counter: sql`counter + 1`
                },
                where: sql`id = {:file_id}`,
                    returning: ['counter']
            }
        ],
    }, {
        name: 'inc_counter_steps',
        params: {file_id: 'integer'},
        applyTableRules: false,
        steps: [
            {
                type: 'UPDATE',
                table: 'files',
                set: {
                    'counter': 'counter + 1',
                },
                where: 'id = params.file_id',
                returning: ['counter']
            }
        ],
    }, {
        name: 'inc_counter_guarded',
        params: {file_id: 'integer'},
        guard: "auth.uid != null",
        applyTableRules: false,
        steps: [
            {
                type: 'UPDATE',
                table: 'files',
                set: {
                    'counter': 'counter + 1',
                },
                where: 'id = params.file_id',
                returning: ['counter']
            }
        ],
    },
    // Part 2: rawSelectRaise smoke tests
    // These use RAISE() in SELECT to confirm it fails outside triggers (regression test)
    {
        name: 'test_raise_match',
        params: {file_id: 'integer'},
        applyTableRules: false,
        sql: {
            type: 'SELECT',
            from: 'files',
            selects: ["RAISE(FAIL, 'Condition matched')"],
            where: sql`id = {:file_id}`,
        },
    },
    {
        name: 'test_raise_nomatch',
        applyTableRules: false,
        sql: {
            type: 'SELECT',
            from: 'files',
            selects: ["RAISE(FAIL, 'Condition matched')"],
            where: sql`id = -999`,
        },
    },
    // Part 3: Comprehensive action tests
    // #1 SELECT sql mode — where, selects, orderBy, limit
    {
        name: 'list_files_sql',
        applyTableRules: false,
        sql: {
            type: 'SELECT',
            from: 'files',
            selects: ['id', 'name'],
            orderBy: 'name ASC',
            limit: 5,
        },
    },
    // #2 SELECT sql mode — aggregation with alias selects, groupBy
    {
        name: 'count_files_by_user_sql',
        applyTableRules: false,
        sql: {
            type: 'SELECT',
            from: 'files',
            selects: ['user_id', {q: 'COUNT(*)', as: 'total'}],
            groupBy: ['user_id'],
            orderBy: 'user_id ASC',
        },
    },
    // #3 INSERT sql mode — values with sql``, returning
    {
        name: 'create_file_sql',
        params: {name: 'string', url: 'string'},
        applyTableRules: false,
        sql: {
            type: 'INSERT',
            table: 'files',
            values: {name: sql`{:name}`, url: sql`{:url}`, user_id: sql`1`},
            returning: ['id', 'name', 'url'],
        },
    },
    // #4 DELETE sql mode — where, returning
    {
        name: 'delete_file_sql',
        params: {file_id: 'integer'},
        applyTableRules: false,
        sql: {
            type: 'DELETE',
            table: 'files',
            where: sql`id = {:file_id}`,
            returning: ['id'],
        },
    },
    // #5 SELECT steps mode
    {
        name: 'list_files_steps',
        applyTableRules: false,
        steps: {
            type: 'SELECT',
            table: 'files',
        },
    },
    // #6 INSERT steps mode — expr for expressions
    {
        name: 'create_file_steps',
        params: {name: 'string', url: 'string'},
        applyTableRules: false,
        steps: {
            type: 'INSERT',
            table: 'files',
            expr: {name: 'params.name', url: 'params.url', user_id: '1'},
        },
    },
    // #7 DELETE steps mode
    {
        name: 'delete_file_steps',
        params: {file_id: 'integer'},
        applyTableRules: false,
        steps: {
            type: 'DELETE',
            table: 'files',
            where: 'id = params.file_id',
        },
    },
    // #8 Multi-query transaction (sql array)
    {
        name: 'swap_names_sql',
        params: {id1: 'integer', id2: 'integer', name1: 'string', name2: 'string'},
        applyTableRules: false,
        sql: [
            {type: 'UPDATE', table: 'files', set: {name: sql`{:name1}`}, where: sql`id = {:id1}`, returning: ['id', 'name']},
            {type: 'UPDATE', table: 'files', set: {name: sql`{:name2}`}, where: sql`id = {:id2}`, returning: ['id', 'name']},
        ],
    },
    // #9 Multi-step workflow (steps array)
    {
        name: 'insert_and_list_steps',
        params: {name: 'string', url: 'string'},
        applyTableRules: false,
        steps: [
            {type: 'INSERT', table: 'files', expr: {name: 'params.name', url: 'params.url', user_id: '1'}},
            {type: 'SELECT', table: 'files'},
        ],
    },
    // #10 applyTableRules: true — verifies RLS rules apply in steps mode
    {
        name: 'list_files_with_rules',
        applyTableRules: true,
        steps: {
            type: 'SELECT',
            table: 'files',
        },
    },
    // #11 Optional param with default
    {
        name: 'list_with_default',
        params: {page: {type: 'integer', optional: true, default: 1}},
        applyTableRules: false,
        sql: {
            type: 'SELECT',
            from: 'files',
            selects: ['id', 'name'],
            limit: 10,
        },
    }]
} satisfies DatabaseSettings
