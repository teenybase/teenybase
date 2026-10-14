import {
    DatabaseSettings,
    sql, sqlValue,
    TableAuthExtensionData,
    TableFieldUsageAuth,
    TableFieldUsageRecord,
    TableRulesExtensionData
} from '../../../src'
import {authFields, baseFields, createdTrigger, updatedTrigger} from '../../../src/scaffolds/fields'

export default {
    appUrl: "https://localhost",
    jwtSecret: 'ldhsadiudsyg76r75vddqdxhaoxindgcx79cxha',
    tables: [
        {
            name: 'users',
            r2Base: 'users',
            autoSetUid: true,
            // allowMultipleFileRef: true,
            // idInR2: true,
            // allowWildcard: false,
            fields: [
                ...baseFields,
                ...authFields,
            ],
            triggers: [createdTrigger, updatedTrigger],
            indexes: [
                {fields: "name"},
                {fields: "role"},
            ],
            extensions: [{
                name: "rules",
                listRule: "(auth.uid == id) | auth.role ~ '%admin'",
                viewRule: "(auth.uid == id) | auth.role ~ '%admin'",
                createRule: "(auth.uid == null & role == 'guest' & meta == '{\"base\": \"/\"}') | auth.role ~ '%admin'",
                updateRule: "(auth.uid == id & role == new.role & meta == new.meta) | auth.role ~ '%admin'",
                deleteRule: "auth.role ~ '%admin'",
            } as TableRulesExtensionData, {
                name: "auth",
                usernameField: "username",
                emailField: "email",
                passwordField: "password",
                passwordType: "sha256",
                metadataField: "meta",
                audFields: ["role"],
                nameField: "name",
                passwordSaltField: undefined,
                emailVerifiedField: "email_verified",
                passwordCurrentSuffix: "Current",
                passwordConfirmSuffix: "Confirm",
                jwtSecret: "asds634r5wicinsxoa8dh236d9w8hsa726x5r23dejwhx",
                jwtTokenDuration: 3 * 60 * 60, // 3 hours
                maxTokenRefresh: 4, // 12 hours
                avatarField: "avatar",
            }as TableAuthExtensionData]
        },
        {
            name: 'files',
            r2Base: 'files',
            autoSetUid: true,
            fields: [
                ...baseFields,
                {name: 'created_by', sqlType: 'text', type: 'relation', foreignKey: {table: 'users', column: 'id', onDelete: 'CASCADE'}},
                {name: 'path', sqlType: 'text', type: 'text', notNull: true},
                {name: 'name', sqlType: 'text', type: 'text', notNull: true},
                {name: 'thumb', sqlType: 'text', type: 'file', default: sqlValue(null)},
                {name: 'file', sqlType: 'text', type: 'file', notNull: false},
                {name: 'notes', sqlType: 'text', type: 'text', notNull: true, default: sqlValue('')},
                {name: 'config', sqlType: 'json', type: 'json', check: sql`json_valid(config)`, default: sqlValue({})},
                {name: 'meta', sqlType: 'json', type: 'json', check: sql`json_valid(meta)`, default: sqlValue({})},
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
            triggers: [createdTrigger, updatedTrigger, {
                name: "set_deleted_at_on_delete_by",
                seq: "BEFORE",
                event: "UPDATE",
                updateOf: "deleted_by",
                body: sql`UPDATE files SET deleted_at = CURRENT_TIMESTAMP WHERE id = NEW.id AND OLD.deleted_by IS NULL AND NEW.deleted_by IS NOT NULL`,
            }],
            extensions: [{
                name: "rules",
                listRule: "auth.uid != null & (path ~ (auth.meta.base||'%') | auth.role ~ '%admin') & auth.role != 'guest'",
                viewRule: "auth.uid != null & (path ~ (auth.meta.base||'%') | auth.role ~ '%admin')",
                createRule: "auth.uid != null & (path ~ (auth.meta.base||'%') | auth.role ~ '%admin' | auth.jwt.user ~ '%admin') & created_by == auth.uid",
                updateRule: "auth.uid != null & (path ~ (auth.meta.base||'%') | auth.role ~ '%admin' | auth.jwt.user ~ '%admin') & created_by == auth.uid",
                // updateRule: null,
                // deleteRule: null,
                deleteRule: "auth.uid != null & (path ~ (auth.meta.base||'%') | auth.role ~ '%admin' | auth.jwt.user ~ '%admin') & created_by == auth.uid",
            } as TableRulesExtensionData]
        },
        {
            name: 'drive_config',
            autoSetUid: false, // this is like kv store
            fields: [
                ...baseFields.filter(f=>f.name!=='id'),
                {name: "id", primary: true, type: 'text', sqlType: 'text', notNull: true, usage: TableFieldUsageRecord.record_uid, noUpdate: false},
                {name: 'val', sqlType: 'text', type: 'text', notNull: false},
                {name: 'protected', sqlType: 'boolean', type: 'bool', notNull: true, default: sqlValue(false)},
            ],
            indexes: [
                {fields: "protected"},
            ],
            triggers: [createdTrigger, updatedTrigger],
            extensions: [{
                name: "rules",
                listRule: "!protected | auth.jwt.user ~ '%admin'",
                viewRule: "!protected | auth.jwt.user ~ '%admin'",
                createRule: "auth.jwt.user ~ '%admin'",
                updateRule: "auth.jwt.user ~ '%admin'",
                deleteRule: "auth.jwt.user ~ '%admin'",
            } as TableRulesExtensionData]
        },
    ]
} satisfies DatabaseSettings
