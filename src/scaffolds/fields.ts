import {TableFieldData} from '../types/field'
import {TableFieldUsageAuth, TableFieldUsageRecord} from '../worker/usages'
import {sql, SQLTrigger, sqlValue} from '../types/sql'

export const baseFields: TableFieldData[] = [
    {name: "id", primary: true, type: 'text', sqlType: 'text', notNull: true, usage: TableFieldUsageRecord.record_uid, noUpdate: true},
    {name: "created", type: 'date', sqlType: 'timestamp', default: sql`CURRENT_TIMESTAMP`, notNull: true, usage: TableFieldUsageRecord.record_created, noInsert: true, noUpdate: true},
    {name: "updated", type: 'date', sqlType: 'timestamp', default: sql`CURRENT_TIMESTAMP`, notNull: true, usage: TableFieldUsageRecord.record_updated, noInsert: true, noUpdate: true},
]

export const authFields: TableFieldData[] = [
    {name: "username", type: 'text', sqlType: 'text', notNull: true, unique: true, usage: TableFieldUsageAuth.auth_username},
    {name: "email", type: 'text', sqlType: 'text', notNull: true, unique: true, usage: TableFieldUsageAuth.auth_email, noUpdate: true},
    {name: "email_verified", type: 'bool', sqlType: 'boolean', notNull: true, default: sqlValue(false), usage: TableFieldUsageAuth.auth_email_verified, noInsert: true, noUpdate: true},
    {name: "password", type: 'text', sqlType: 'text', notNull: true, usage: TableFieldUsageAuth.auth_password, noSelect: true},
    {name: "password_salt", type: 'text', sqlType: 'text', notNull: true, usage: TableFieldUsageAuth.auth_password_salt, noSelect: true, noInsert: true, noUpdate: true},
    {name: "name", type: 'text', sqlType: 'text', notNull: true, usage: TableFieldUsageAuth.auth_name},
    {name: "avatar", sqlType: 'text', type: 'file', usage: TableFieldUsageAuth.auth_avatar},
    {name: "role", type: 'text', sqlType: 'text', usage: TableFieldUsageAuth.auth_audience},
    {name: "meta", type: 'json', sqlType: 'json', usage: TableFieldUsageAuth.auth_metadata},
]

// raise an error if created column is updated (optional, only when executing raw sql)
export const createdTrigger: SQLTrigger = {
    name: "raise_on_created_update",
    seq: "BEFORE",
    event: "UPDATE",
    updateOf: ["created"],
    body: sql`SELECT RAISE(FAIL, 'Cannot update created column') WHERE OLD.created != NEW.created`,
}

// update updated column automatically (optional, only when executing raw sql)
export const updatedTrigger: SQLTrigger = {
    name: "update_updated_on_update",
    seq: "AFTER",
    event: "UPDATE",
    body: sql`UPDATE users SET updated = CURRENT_TIMESTAMP WHERE id = NEW.id AND OLD.updated = NEW.updated`,
}
