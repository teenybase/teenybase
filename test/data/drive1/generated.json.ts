import {DatabaseSettings} from '../../../src'
export const migrations = [
  {
    "name": "10000_create_table_users.sql",
    "sql": "CREATE TABLE users (\n\tid TEXT PRIMARY KEY NOT NULL, \n\tname TEXT NOT NULL, \n\temail TEXT UNIQUE NOT NULL, \n\temail_verified BOOLEAN DEFAULT 0, \n\tusername TEXT UNIQUE NOT NULL, \n\tpassword TEXT NOT NULL, \n\tcreated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, \n\trole TEXT DEFAULT \"guest\", \n\tmeta JSON DEFAULT \"{}\", \n\tavatar TEXT DEFAULT NULL\n);\nCREATE INDEX idx_users_name ON users (name);\nCREATE INDEX idx_users_role ON users (role);\nCREATE TRIGGER tgr_users_raise_on_created_update BEFORE UPDATE OF created ON users BEGIN SELECT RAISE(FAIL, 'Cannot update created column') WHERE OLD.created != NEW.created; END;",
    "sqlRevert": "DROP TABLE IF EXISTS users;",
    "logs": [
      "✔ Table Created - users"
    ]
  },
  {
    "name": "10001_create_table_files.sql",
    "sql": "CREATE TABLE files (\n\tid TEXT PRIMARY KEY NOT NULL, \n\tcreated TIMESTAMP DEFAULT CURRENT_TIMESTAMP, \n\tupdated TIMESTAMP DEFAULT CURRENT_TIMESTAMP, \n\tpath TEXT NOT NULL, \n\tname TEXT NOT NULL, \n\tthumb TEXT, \n\tfile TEXT, \n\tnotes TEXT NOT NULL DEFAULT \"\", \n\tconfig JSON CHECK(json_valid(config)), \n\tmeta JSON CHECK(json_valid(meta)), \n\tcreated_by TEXT REFERENCES users(id) ON DELETE CASCADE, \n\ttags TEXT, \n\tdeleted_by TEXT REFERENCES users(id) ON DELETE SET NULL, \n\tdeleted_at TIMESTAMP\n);\nCREATE INDEX idx_files_name ON files (name);\nCREATE INDEX idx_files_path ON files (path);\nCREATE INDEX idx_files_tags ON files (tags);\nCREATE INDEX idx_files_created_by ON files (created_by);\nCREATE INDEX idx_files_deleted_by ON files (deleted_by);\nCREATE TRIGGER tgr_files_raise_on_created_update BEFORE UPDATE OF created ON files BEGIN SELECT RAISE(FAIL, 'Cannot update created column') WHERE OLD.created != NEW.created; END;\nCREATE TRIGGER tgr_files_set_deleted_at_on_delete_by BEFORE UPDATE OF deleted_by ON files BEGIN UPDATE files SET deleted_at = CURRENT_TIMESTAMP WHERE id = NEW.id AND OLD.deleted_by IS NULL AND NEW.deleted_by IS NOT NULL; END;",
    "sqlRevert": "DROP TABLE IF EXISTS files;",
    "logs": [
      "✔ Table Created - files"
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
          "name": "name",
          "sqlType": "text",
          "type": "text",
          "usage": "auth_name",
          "notNull": true
        },
        {
          "name": "email",
          "sqlType": "text",
          "type": "email",
          "usage": "auth_email",
          "unique": true,
          "notNull": true
        },
        {
          "name": "email_verified",
          "sqlType": "boolean",
          "type": "bool",
          "usage": "auth_email_verified",
          "default": {
            "l": false
          }
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
          "name": "password",
          "sqlType": "text",
          "type": "text",
          "usage": "auth_password",
          "notNull": true,
          "noSelect": true
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
          "name": "role",
          "sqlType": "text",
          "type": "text",
          "usage": "auth_audience",
          "default": {
            "l": "guest"
          }
        },
        {
          "name": "meta",
          "sqlType": "json",
          "type": "json",
          "usage": "auth_metadata",
          "default": {
            "l": "{}"
          }
        },
        {
          "name": "avatar",
          "sqlType": "text",
          "type": "file",
          "usage": "auth_avatar",
          "default": {
            "l": null
          }
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
        }
      ],
      "autoSetUid": true,
      "extensions": [
        {
          "name": "rules",
          "listRule": "auth.uid == id",
          "viewRule": "auth.uid == id",
          "createRule": "auth.uid == null & role = 'guest'",
          "updateRule": null,
          "deleteRule": null
        },
        {
          "name": "auth",
          "passwordType": "sha256",
          "jwtSecret": "akjbiohxsjapmxu2djsa",
          "jwtTokenDuration": 3600,
          "maxTokenRefresh": 30,
          "passwordCurrentSuffix": "Current",
          "passwordConfirmSuffix": "Confirm"
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
          "default": {
            "q": "CURRENT_TIMESTAMP"
          },
          "noUpdate": true,
          "noInsert": true
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
          "type": "file"
        },
        {
          "name": "file",
          "sqlType": "text",
          "type": "file"
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
          "check": {
            "q": "json_valid(config)"
          }
        },
        {
          "name": "meta",
          "sqlType": "json",
          "type": "json",
          "check": {
            "q": "json_valid(meta)"
          }
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
          "listRule": "auth.uid == id",
          "viewRule": "auth.uid == id",
          "createRule": "auth.uid == null & role = null",
          "updateRule": null,
          "deleteRule": null
        }
      ]
    }
  ],
  "jwtSecret": "ldhsadiudsadqdxhaoxindgcx79cxha",
  "appUrl": "https://localhost",
  "actions": [
    {
      "name": "mark_verified",
      "description": "Mark a user email as verified (test-only)",
      "applyTableRules": false,
      "requireAuth": false,
      "params": {
        "email": "string",
        "id": "string"
      },
      "sql": {
        "type": "UPDATE",
        "table": "users",
        "set": {
          "email_verified": {
            "l": true
          }
        },
        "where": {
          "q": "{:email} LIKE '%@example.com' AND email = {:email} AND email_verified = false AND id = {:id}"
        },
        "returning": [
          "*"
        ]
      }
    },
    {
      "name": "mark_verified_stat",
      "applyTableRules": false,
      "requireAuth": true,
      "params": {
        "email": "string"
      },
      "steps": {
        "where": "email = params.email & email_verified = false & email ~ '%@example.com' & id = auth.uid",
        "setValues": {
          "email_verified": true
        },
        "type": "UPDATE",
        "table": "users"
      }
    },
    {
      "name": "mark_verified_guarded",
      "guard": "auth.uid != null",
      "applyTableRules": false,
      "requireAuth": false,
      "params": {
        "email": "string",
        "id": "string"
      },
      "sql": {
        "type": "UPDATE",
        "table": "users",
        "set": {
          "email_verified": {
            "l": true
          }
        },
        "where": {
          "q": "{:email} LIKE '%@example.com' AND email = {:email} AND email_verified = false AND id = {:id}"
        },
        "returning": [
          "*"
        ]
      }
    }
  ]
} as const satisfies DatabaseSettings
