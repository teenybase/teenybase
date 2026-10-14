import {DatabaseSettings} from '../../../src'
export const migrations = [
  {
    "name": "10000_create_table_users.sql",
    "sql": "CREATE TABLE users (\n\tid TEXT PRIMARY KEY NOT NULL, \n\tcreated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, \n\tupdated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, \n\tusername TEXT UNIQUE NOT NULL, \n\temail TEXT UNIQUE NOT NULL, \n\temail_verified BOOLEAN NOT NULL DEFAULT 0, \n\tpassword TEXT NOT NULL, \n\tpassword_salt TEXT NOT NULL, \n\tname TEXT NOT NULL, \n\tavatar TEXT, \n\trole TEXT, \n\tmeta JSON\n);\nCREATE INDEX idx_users_name ON users (name);\nCREATE INDEX idx_users_role ON users (role);\nCREATE TRIGGER tgr_users_raise_on_created_update BEFORE UPDATE OF created ON users BEGIN SELECT RAISE(FAIL, 'Cannot update created column') WHERE OLD.created != NEW.created; END;\nCREATE TRIGGER tgr_users_update_updated_on_update AFTER UPDATE ON users BEGIN UPDATE users SET updated = CURRENT_TIMESTAMP WHERE id = NEW.id AND OLD.updated = NEW.updated; END;",
    "sqlRevert": "DROP TABLE IF EXISTS users;",
    "logs": [
      "✔ Table Created - users"
    ]
  },
  {
    "name": "10001_create_table_files.sql",
    "sql": "CREATE TABLE files (\n\tid TEXT PRIMARY KEY NOT NULL, \n\tcreated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, \n\tupdated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, \n\tcreated_by TEXT REFERENCES users(id) ON DELETE CASCADE, \n\tpath TEXT NOT NULL, \n\tname TEXT NOT NULL, \n\tthumb TEXT DEFAULT NULL, \n\tfile TEXT, \n\tnotes TEXT NOT NULL DEFAULT \"\", \n\tconfig JSON DEFAULT \"{}\" CHECK(json_valid(config)), \n\tmeta JSON DEFAULT \"{}\" CHECK(json_valid(meta)), \n\ttags TEXT, \n\tdeleted_by TEXT REFERENCES users(id) ON DELETE SET NULL, \n\tdeleted_at TIMESTAMP\n);\nCREATE INDEX idx_files_name ON files (name);\nCREATE INDEX idx_files_path ON files (path);\nCREATE INDEX idx_files_tags ON files (tags);\nCREATE INDEX idx_files_created_by ON files (created_by);\nCREATE INDEX idx_files_deleted_by ON files (deleted_by);\nCREATE TRIGGER tgr_files_raise_on_created_update BEFORE UPDATE OF created ON files BEGIN SELECT RAISE(FAIL, 'Cannot update created column') WHERE OLD.created != NEW.created; END;\nCREATE TRIGGER tgr_files_update_updated_on_update AFTER UPDATE ON files BEGIN UPDATE files SET updated = CURRENT_TIMESTAMP WHERE id = NEW.id AND OLD.updated = NEW.updated; END;\nCREATE TRIGGER tgr_files_set_deleted_at_on_delete_by BEFORE UPDATE OF deleted_by ON files BEGIN UPDATE files SET deleted_at = CURRENT_TIMESTAMP WHERE id = NEW.id AND OLD.deleted_by IS NULL AND NEW.deleted_by IS NOT NULL; END;",
    "sqlRevert": "DROP TABLE IF EXISTS files;",
    "logs": [
      "✔ Table Created - files"
    ]
  },
  {
    "name": "10002_create_table_drive_config.sql",
    "sql": "CREATE TABLE drive_config (\n\tcreated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, \n\tupdated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, \n\tid TEXT PRIMARY KEY NOT NULL, \n\tval TEXT, \n\tprotected BOOLEAN NOT NULL DEFAULT 0\n);\nCREATE INDEX idx_drive_config_protected ON drive_config (protected);\nCREATE TRIGGER tgr_drive_config_raise_on_created_update BEFORE UPDATE OF created ON drive_config BEGIN SELECT RAISE(FAIL, 'Cannot update created column') WHERE OLD.created != NEW.created; END;\nCREATE TRIGGER tgr_drive_config_update_updated_on_update AFTER UPDATE ON drive_config BEGIN UPDATE drive_config SET updated = CURRENT_TIMESTAMP WHERE id = NEW.id AND OLD.updated = NEW.updated; END;",
    "sqlRevert": "DROP TABLE IF EXISTS drive_config;",
    "logs": [
      "✔ Table Created - drive_config"
    ]
  }
]
export const config = {
  "tables": [
    {
      "name": "users",
      "r2Base": "users",
      "fields": [
        {
          "name": "id",
          "sqlType": "text",
          "type": "text",
          "usage": "record_uid",
          "primary": true,
          "notNull": true,
          "noUpdate": true
        },
        {
          "name": "created",
          "sqlType": "timestamp",
          "type": "date",
          "usage": "record_created",
          "notNull": true,
          "default": {
            "q": "CURRENT_TIMESTAMP"
          },
          "noUpdate": true,
          "noInsert": true
        },
        {
          "name": "updated",
          "sqlType": "timestamp",
          "type": "date",
          "usage": "record_updated",
          "notNull": true,
          "default": {
            "q": "CURRENT_TIMESTAMP"
          },
          "noUpdate": true,
          "noInsert": true
        },
        {
          "name": "username",
          "sqlType": "text",
          "type": "text",
          "usage": "auth_username",
          "unique": true,
          "notNull": true
        },
        {
          "name": "email",
          "sqlType": "text",
          "type": "text",
          "usage": "auth_email",
          "unique": true,
          "notNull": true,
          "noUpdate": true
        },
        {
          "name": "email_verified",
          "sqlType": "boolean",
          "type": "bool",
          "usage": "auth_email_verified",
          "notNull": true,
          "default": {
            "l": false
          },
          "noUpdate": true,
          "noInsert": true
        },
        {
          "name": "password",
          "sqlType": "text",
          "type": "text",
          "usage": "auth_password",
          "notNull": true,
          "noSelect": true
        },
        {
          "name": "password_salt",
          "sqlType": "text",
          "type": "text",
          "usage": "auth_password_salt",
          "notNull": true,
          "noUpdate": true,
          "noInsert": true,
          "noSelect": true
        },
        {
          "name": "name",
          "sqlType": "text",
          "type": "text",
          "usage": "auth_name",
          "notNull": true
        },
        {
          "name": "avatar",
          "sqlType": "text",
          "type": "file",
          "usage": "auth_avatar"
        },
        {
          "name": "role",
          "sqlType": "text",
          "type": "text",
          "usage": "auth_audience"
        },
        {
          "name": "meta",
          "sqlType": "json",
          "type": "json",
          "usage": "auth_metadata"
        }
      ],
      "indexes": [
        {
          "fields": "name"
        },
        {
          "fields": "role"
        }
      ],
      "triggers": [
        {
          "name": "raise_on_created_update",
          "event": "UPDATE",
          "seq": "BEFORE",
          "updateOf": [
            "created"
          ],
          "body": {
            "q": "SELECT RAISE(FAIL, 'Cannot update created column') WHERE OLD.created != NEW.created"
          }
        },
        {
          "name": "update_updated_on_update",
          "event": "UPDATE",
          "seq": "AFTER",
          "body": {
            "q": "UPDATE \u0000TABLEREF\u0000 SET updated = CURRENT_TIMESTAMP WHERE id = NEW.id AND OLD.updated = NEW.updated"
          }
        }
      ],
      "autoSetUid": true,
      "extensions": [
        {
          "name": "rules",
          "listRule": "(auth.uid == id) | auth.role ~ '%admin'",
          "viewRule": "(auth.uid == id) | auth.role ~ '%admin'",
          "createRule": "(auth.uid == null & role == 'guest' & meta == '{\"base\": \"/\"}') | auth.role ~ '%admin'",
          "updateRule": "(auth.uid == id & role == new.role & meta == new.meta) | auth.role ~ '%admin'",
          "deleteRule": "auth.role ~ '%admin'"
        },
        {
          "name": "auth",
          "usernameField": "username",
          "emailField": "email",
          "passwordField": "password",
          "passwordType": "sha256",
          "metadataField": "meta",
          "audFields": [
            "role"
          ],
          "nameField": "name",
          "emailVerifiedField": "email_verified",
          "passwordCurrentSuffix": "Current",
          "passwordConfirmSuffix": "Confirm",
          "jwtSecret": "asds634r5wicinsxoa8dh236d9w8hsa726x5r23dejwhx",
          "jwtTokenDuration": 10800,
          "maxTokenRefresh": 4,
          "avatarField": "avatar"
        }
      ]
    },
    {
      "name": "files",
      "r2Base": "files",
      "fields": [
        {
          "name": "id",
          "sqlType": "text",
          "type": "text",
          "usage": "record_uid",
          "primary": true,
          "notNull": true,
          "noUpdate": true
        },
        {
          "name": "created",
          "sqlType": "timestamp",
          "type": "date",
          "usage": "record_created",
          "notNull": true,
          "default": {
            "q": "CURRENT_TIMESTAMP"
          },
          "noUpdate": true,
          "noInsert": true
        },
        {
          "name": "updated",
          "sqlType": "timestamp",
          "type": "date",
          "usage": "record_updated",
          "notNull": true,
          "default": {
            "q": "CURRENT_TIMESTAMP"
          },
          "noUpdate": true,
          "noInsert": true
        },
        {
          "name": "created_by",
          "sqlType": "text",
          "type": "relation",
          "foreignKey": {
            "table": "users",
            "column": "id",
            "onDelete": "CASCADE"
          }
        },
        {
          "name": "path",
          "sqlType": "text",
          "type": "text",
          "notNull": true
        },
        {
          "name": "name",
          "sqlType": "text",
          "type": "text",
          "notNull": true
        },
        {
          "name": "thumb",
          "sqlType": "text",
          "type": "file",
          "default": {
            "l": null
          }
        },
        {
          "name": "file",
          "sqlType": "text",
          "type": "file",
          "notNull": false
        },
        {
          "name": "notes",
          "sqlType": "text",
          "type": "text",
          "notNull": true,
          "default": {
            "l": ""
          }
        },
        {
          "name": "config",
          "sqlType": "json",
          "type": "json",
          "default": {
            "l": {}
          },
          "check": {
            "q": "json_valid(config)"
          }
        },
        {
          "name": "meta",
          "sqlType": "json",
          "type": "json",
          "default": {
            "l": {}
          },
          "check": {
            "q": "json_valid(meta)"
          }
        },
        {
          "name": "tags",
          "sqlType": "text",
          "type": "text"
        },
        {
          "name": "deleted_by",
          "sqlType": "text",
          "type": "relation",
          "foreignKey": {
            "table": "users",
            "column": "id",
            "onDelete": "SET NULL"
          }
        },
        {
          "name": "deleted_at",
          "sqlType": "timestamp",
          "type": "date"
        }
      ],
      "indexes": [
        {
          "fields": "name"
        },
        {
          "fields": "path"
        },
        {
          "fields": "tags"
        },
        {
          "fields": "created_by"
        },
        {
          "fields": "deleted_by"
        }
      ],
      "triggers": [
        {
          "name": "raise_on_created_update",
          "event": "UPDATE",
          "seq": "BEFORE",
          "updateOf": [
            "created"
          ],
          "body": {
            "q": "SELECT RAISE(FAIL, 'Cannot update created column') WHERE OLD.created != NEW.created"
          }
        },
        {
          "name": "update_updated_on_update",
          "event": "UPDATE",
          "seq": "AFTER",
          "body": {
            "q": "UPDATE \u0000TABLEREF\u0000 SET updated = CURRENT_TIMESTAMP WHERE id = NEW.id AND OLD.updated = NEW.updated"
          }
        },
        {
          "name": "set_deleted_at_on_delete_by",
          "event": "UPDATE",
          "seq": "BEFORE",
          "updateOf": "deleted_by",
          "body": {
            "q": "UPDATE files SET deleted_at = CURRENT_TIMESTAMP WHERE id = NEW.id AND OLD.deleted_by IS NULL AND NEW.deleted_by IS NOT NULL"
          }
        }
      ],
      "autoSetUid": true,
      "extensions": [
        {
          "name": "rules",
          "listRule": "auth.uid != null & (path ~ (auth.meta.base||'%') | auth.role ~ '%admin') & auth.role != 'guest'",
          "viewRule": "auth.uid != null & (path ~ (auth.meta.base||'%') | auth.role ~ '%admin')",
          "createRule": "auth.uid != null & (path ~ (auth.meta.base||'%') | auth.role ~ '%admin' | auth.jwt.user ~ '%admin') & created_by == auth.uid",
          "updateRule": "auth.uid != null & (path ~ (auth.meta.base||'%') | auth.role ~ '%admin' | auth.jwt.user ~ '%admin') & created_by == auth.uid",
          "deleteRule": "auth.uid != null & (path ~ (auth.meta.base||'%') | auth.role ~ '%admin' | auth.jwt.user ~ '%admin') & created_by == auth.uid"
        }
      ]
    },
    {
      "name": "drive_config",
      "fields": [
        {
          "name": "created",
          "sqlType": "timestamp",
          "type": "date",
          "usage": "record_created",
          "notNull": true,
          "default": {
            "q": "CURRENT_TIMESTAMP"
          },
          "noUpdate": true,
          "noInsert": true
        },
        {
          "name": "updated",
          "sqlType": "timestamp",
          "type": "date",
          "usage": "record_updated",
          "notNull": true,
          "default": {
            "q": "CURRENT_TIMESTAMP"
          },
          "noUpdate": true,
          "noInsert": true
        },
        {
          "name": "id",
          "sqlType": "text",
          "type": "text",
          "usage": "record_uid",
          "primary": true,
          "notNull": true,
          "noUpdate": false
        },
        {
          "name": "val",
          "sqlType": "text",
          "type": "text",
          "notNull": false
        },
        {
          "name": "protected",
          "sqlType": "boolean",
          "type": "bool",
          "notNull": true,
          "default": {
            "l": false
          }
        }
      ],
      "indexes": [
        {
          "fields": "protected"
        }
      ],
      "triggers": [
        {
          "name": "raise_on_created_update",
          "event": "UPDATE",
          "seq": "BEFORE",
          "updateOf": [
            "created"
          ],
          "body": {
            "q": "SELECT RAISE(FAIL, 'Cannot update created column') WHERE OLD.created != NEW.created"
          }
        },
        {
          "name": "update_updated_on_update",
          "event": "UPDATE",
          "seq": "AFTER",
          "body": {
            "q": "UPDATE \u0000TABLEREF\u0000 SET updated = CURRENT_TIMESTAMP WHERE id = NEW.id AND OLD.updated = NEW.updated"
          }
        }
      ],
      "autoSetUid": false,
      "extensions": [
        {
          "name": "rules",
          "listRule": "!protected | auth.jwt.user ~ '%admin'",
          "viewRule": "!protected | auth.jwt.user ~ '%admin'",
          "createRule": "auth.jwt.user ~ '%admin'",
          "updateRule": "auth.jwt.user ~ '%admin'",
          "deleteRule": "auth.jwt.user ~ '%admin'"
        }
      ]
    }
  ],
  "jwtSecret": "ldhsadiudsyg76r75vddqdxhaoxindgcx79cxha",
  "appUrl": "https://localhost"
} as const satisfies DatabaseSettings
