import {DatabaseSettings} from '../../../src'
export const migrations = [
  {
    "name": "10000_create_table_users.sql",
    "sql": "CREATE TABLE users (\n\tid INTEGER PRIMARY KEY AUTOINCREMENT, \n\tname TEXT NOT NULL, \n\temail TEXT UNIQUE NOT NULL, \n\tuid TEXT UNIQUE NOT NULL, \n\tpass_hash TEXT NOT NULL, \n\tcreated TIMESTAMP DEFAULT CURRENT_TIMESTAMP, \n\tupdated TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);\nCREATE INDEX idx_users_name ON users (name);\nCREATE TRIGGER tgr_users_raise_on_created_update BEFORE UPDATE OF created ON users BEGIN SELECT RAISE(FAIL, 'Cannot update created column') WHERE OLD.created != NEW.created; END;\nCREATE TRIGGER tgr_users_update_updated_on_update AFTER UPDATE ON users BEGIN UPDATE users SET updated = CURRENT_TIMESTAMP WHERE id = NEW.id AND OLD.updated = NEW.updated; END;",
    "sqlRevert": "DROP TABLE IF EXISTS users;",
    "logs": [
      "✔ Table Created - users"
    ]
  },
  {
    "name": "10001_create_table_files.sql",
    "sql": "CREATE TABLE files (\n\tid INTEGER PRIMARY KEY AUTOINCREMENT, \n\tname TEXT NOT NULL, \n\turl TEXT NOT NULL, \n\tmetadata JSON CHECK(json_valid(metadata)), \n\tuser_id INTEGER REFERENCES users(id) ON DELETE CASCADE, \n\tcreated TIMESTAMP DEFAULT CURRENT_TIMESTAMP, \n\tcounter INTEGER NOT NULL DEFAULT 0\n);\nCREATE INDEX idx_files_name ON files (name);\nCREATE INDEX idx_files_user_id ON files (user_id);",
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
      "allowWildcard": false,
      "fields": [
        {
          "name": "id",
          "sqlType": "integer",
          "type": "integer",
          "usage": "record_uid",
          "primary": true,
          "autoIncrement": true,
          "noUpdate": true,
          "noInsert": true
        },
        {
          "name": "name",
          "sqlType": "text",
          "type": "text",
          "notNull": true
        },
        {
          "name": "email",
          "sqlType": "text",
          "type": "email",
          "unique": true,
          "notNull": true
        },
        {
          "name": "uid",
          "sqlType": "text",
          "type": "text",
          "unique": true,
          "notNull": true
        },
        {
          "name": "pass_hash",
          "sqlType": "text",
          "type": "text",
          "notNull": true
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
        }
      ],
      "indexes": [
        {
          "fields": "name"
        }
      ],
      "triggers": [
        {
          "name": "raise_on_created_update",
          "event": "UPDATE",
          "seq": "BEFORE",
          "updateOf": "created",
          "body": {
            "q": "SELECT RAISE(FAIL, 'Cannot update created column') WHERE OLD.created != NEW.created"
          }
        },
        {
          "name": "update_updated_on_update",
          "event": "UPDATE",
          "seq": "AFTER",
          "body": {
            "q": "UPDATE users SET updated = CURRENT_TIMESTAMP WHERE id = NEW.id AND OLD.updated = NEW.updated"
          }
        }
      ],
      "autoSetUid": false,
      "extensions": [
        {
          "name": "rules",
          "listRule": "true",
          "viewRule": "true",
          "createRule": "true",
          "updateRule": "true",
          "deleteRule": "true"
        }
      ]
    },
    {
      "name": "files",
      "r2Base": "files",
      "fields": [
        {
          "name": "id",
          "sqlType": "integer",
          "type": "integer",
          "usage": "record_uid",
          "primary": true,
          "autoIncrement": true,
          "noUpdate": true,
          "noInsert": true
        },
        {
          "name": "name",
          "sqlType": "text",
          "type": "text",
          "notNull": true
        },
        {
          "name": "url",
          "sqlType": "text",
          "type": "url",
          "notNull": true
        },
        {
          "name": "metadata",
          "sqlType": "json",
          "type": "json",
          "check": {
            "q": "json_valid(metadata)"
          }
        },
        {
          "name": "user_id",
          "sqlType": "integer",
          "type": "relation",
          "foreignKey": {
            "table": "users",
            "column": "id",
            "onDelete": "CASCADE"
          }
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
          "name": "counter",
          "sqlType": "integer",
          "type": "integer",
          "notNull": true,
          "default": {
            "l": 0
          },
          "noUpdate": true,
          "noInsert": true
        }
      ],
      "indexes": [
        {
          "fields": "name"
        },
        {
          "fields": "user_id"
        }
      ],
      "autoSetUid": false,
      "extensions": [
        {
          "name": "rules",
          "listRule": "true",
          "viewRule": "true",
          "createRule": "true",
          "updateRule": "true",
          "deleteRule": "true"
        }
      ]
    }
  ],
  "jwtSecret": "asdadqdihxwdsuhcwhc0cwe8hnwcw",
  "appUrl": "https://localhost",
  "actions": [
    {
      "name": "inc_counter_sql",
      "applyTableRules": false,
      "requireAuth": false,
      "params": {
        "file_id": "integer"
      },
      "sql": [
        {
          "type": "UPDATE",
          "table": "files",
          "set": {
            "counter": {
              "q": "counter + 1"
            }
          },
          "where": {
            "q": "id = {:file_id}"
          },
          "returning": [
            "counter"
          ]
        }
      ]
    },
    {
      "name": "inc_counter_steps",
      "applyTableRules": false,
      "requireAuth": false,
      "params": {
        "file_id": "integer"
      },
      "steps": [
        {
          "set": {
            "counter": "counter + 1"
          },
          "where": "id = params.file_id",
          "returning": [
            "counter"
          ],
          "type": "UPDATE",
          "table": "files"
        }
      ]
    },
    {
      "name": "inc_counter_guarded",
      "guard": "auth.uid != null",
      "applyTableRules": false,
      "requireAuth": false,
      "params": {
        "file_id": "integer"
      },
      "steps": [
        {
          "set": {
            "counter": "counter + 1"
          },
          "where": "id = params.file_id",
          "returning": [
            "counter"
          ],
          "type": "UPDATE",
          "table": "files"
        }
      ]
    },
    {
      "name": "test_raise_match",
      "applyTableRules": false,
      "requireAuth": false,
      "params": {
        "file_id": "integer"
      },
      "sql": {
        "type": "SELECT",
        "from": "files",
        "selects": [
          "RAISE(FAIL, 'Condition matched')"
        ],
        "where": {
          "q": "id = {:file_id}"
        }
      }
    },
    {
      "name": "test_raise_nomatch",
      "applyTableRules": false,
      "requireAuth": false,
      "sql": {
        "type": "SELECT",
        "from": "files",
        "selects": [
          "RAISE(FAIL, 'Condition matched')"
        ],
        "where": {
          "q": "id = -999"
        }
      }
    },
    {
      "name": "list_files_sql",
      "applyTableRules": false,
      "requireAuth": false,
      "sql": {
        "type": "SELECT",
        "from": "files",
        "selects": [
          "id",
          "name"
        ],
        "orderBy": "name ASC",
        "limit": 5
      }
    },
    {
      "name": "count_files_by_user_sql",
      "applyTableRules": false,
      "requireAuth": false,
      "sql": {
        "type": "SELECT",
        "from": "files",
        "selects": [
          "user_id",
          {
            "q": "COUNT(*)",
            "as": "total"
          }
        ],
        "orderBy": "user_id ASC",
        "groupBy": [
          "user_id"
        ]
      }
    },
    {
      "name": "create_file_sql",
      "applyTableRules": false,
      "requireAuth": false,
      "params": {
        "name": "string",
        "url": "string"
      },
      "sql": {
        "type": "INSERT",
        "table": "files",
        "values": {
          "name": {
            "q": "{:name}"
          },
          "url": {
            "q": "{:url}"
          },
          "user_id": {
            "q": "1"
          }
        },
        "returning": [
          "id",
          "name",
          "url"
        ]
      }
    },
    {
      "name": "delete_file_sql",
      "applyTableRules": false,
      "requireAuth": false,
      "params": {
        "file_id": "integer"
      },
      "sql": {
        "type": "DELETE",
        "table": "files",
        "where": {
          "q": "id = {:file_id}"
        },
        "returning": [
          "id"
        ]
      }
    },
    {
      "name": "list_files_steps",
      "applyTableRules": false,
      "requireAuth": false,
      "steps": {
        "type": "SELECT",
        "table": "files"
      }
    },
    {
      "name": "create_file_steps",
      "applyTableRules": false,
      "requireAuth": false,
      "params": {
        "name": "string",
        "url": "string"
      },
      "steps": {
        "expr": {
          "name": "params.name",
          "url": "params.url",
          "user_id": "1"
        },
        "type": "INSERT",
        "table": "files"
      }
    },
    {
      "name": "delete_file_steps",
      "applyTableRules": false,
      "requireAuth": false,
      "params": {
        "file_id": "integer"
      },
      "steps": {
        "where": "id = params.file_id",
        "type": "DELETE",
        "table": "files"
      }
    },
    {
      "name": "swap_names_sql",
      "applyTableRules": false,
      "requireAuth": false,
      "params": {
        "id1": "integer",
        "id2": "integer",
        "name1": "string",
        "name2": "string"
      },
      "sql": [
        {
          "type": "UPDATE",
          "table": "files",
          "set": {
            "name": {
              "q": "{:name1}"
            }
          },
          "where": {
            "q": "id = {:id1}"
          },
          "returning": [
            "id",
            "name"
          ]
        },
        {
          "type": "UPDATE",
          "table": "files",
          "set": {
            "name": {
              "q": "{:name2}"
            }
          },
          "where": {
            "q": "id = {:id2}"
          },
          "returning": [
            "id",
            "name"
          ]
        }
      ]
    },
    {
      "name": "insert_and_list_steps",
      "applyTableRules": false,
      "requireAuth": false,
      "params": {
        "name": "string",
        "url": "string"
      },
      "steps": [
        {
          "expr": {
            "name": "params.name",
            "url": "params.url",
            "user_id": "1"
          },
          "type": "INSERT",
          "table": "files"
        },
        {
          "type": "SELECT",
          "table": "files"
        }
      ]
    },
    {
      "name": "list_files_with_rules",
      "applyTableRules": true,
      "requireAuth": false,
      "steps": {
        "type": "SELECT",
        "table": "files"
      }
    },
    {
      "name": "list_with_default",
      "applyTableRules": false,
      "requireAuth": false,
      "params": {
        "page": {
          "type": "integer",
          "optional": true,
          "default": 1
        }
      },
      "sql": {
        "type": "SELECT",
        "from": "files",
        "selects": [
          "id",
          "name"
        ],
        "limit": 10
      }
    }
  ]
} as const satisfies DatabaseSettings
