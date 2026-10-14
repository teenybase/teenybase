import {TableFieldUsageAuth, TableFieldUsageRecord} from '../worker/usages'
import {SQLTrigger} from '../types/sql'
import {tableField} from '../types/config/tableField';
import {sql, sqlValue} from '../types/config/sqlUtils'

/** Placeholder for the current table name in trigger bodies. Resolved at migration generation time. */
export const TABLE_REF_TOKEN = '\x00TABLEREF\x00'

export const fields = {
    id: tableField("id" as const, 'text', 'text', {usage: TableFieldUsageRecord.record_uid, primary: true, notNull: true, noUpdate: true}),
    created: tableField("created" as const, 'date', 'timestamp', {usage: TableFieldUsageRecord.record_created, default: sql`CURRENT_TIMESTAMP`, notNull: true, noInsert: true, noUpdate: true}),
    updated: tableField("updated" as const, 'date', 'timestamp', {usage: TableFieldUsageRecord.record_updated, default: sql`CURRENT_TIMESTAMP`, notNull: true, noInsert: true, noUpdate: true}),
    username: tableField("username" as const, 'text', 'text', {notNull: true, unique: true, usage: TableFieldUsageAuth.auth_username}),
    email: tableField("email" as const, 'text', 'text', {notNull: true, unique: true, usage: TableFieldUsageAuth.auth_email, noUpdate: true}),
    email_verified: tableField("email_verified" as const, 'bool', 'boolean', {notNull: true, default: sqlValue(false), usage: TableFieldUsageAuth.auth_email_verified, noInsert: true, noUpdate: true}),
    password: tableField("password" as const, 'text', 'text', {notNull: true, usage: TableFieldUsageAuth.auth_password, noSelect: true}),
    password_salt: tableField("password_salt" as const, 'text', 'text', {notNull: true, usage: TableFieldUsageAuth.auth_password_salt, noSelect: true, noInsert: true, noUpdate: true}),
    name: tableField("name" as const, 'text', 'text', {notNull: true, usage: TableFieldUsageAuth.auth_name}),
    avatar: tableField("avatar" as const, 'file', 'text', {usage: TableFieldUsageAuth.auth_avatar}),
    role: tableField("role" as const, 'text', 'text', {usage: TableFieldUsageAuth.auth_audience}),
    meta: tableField("meta" as const, 'json', 'json', {usage: TableFieldUsageAuth.auth_metadata}),
} as const

export const triggers = {
    // raise an error if created column is updated (optional, only when executing raw sql)
    created: {
        name: "raise_on_created_update",
        seq: "BEFORE",
        event: "UPDATE",
        updateOf: [fields.created.name],
        body: sql`SELECT RAISE(FAIL, 'Cannot update created column') WHERE OLD.${fields.created.name} != NEW.${fields.created.name}`,
    } as const satisfies SQLTrigger,
    // update updated column automatically (optional, only when executing raw sql)
    updated: {
        name: "update_updated_on_update",
        seq: "AFTER",
        event: "UPDATE",
        body: sql`UPDATE ${TABLE_REF_TOKEN} SET ${fields.updated.name} = CURRENT_TIMESTAMP WHERE id = NEW.id AND OLD.${fields.updated.name} = NEW.${fields.updated.name}`,
    } as const satisfies SQLTrigger,
} as const

export const baseFields = [fields.id, fields.created, fields.updated] as const
export const authFields = [fields.username, fields.email, fields.email_verified, fields.password, fields.password_salt, fields.name, fields.avatar, fields.role, fields.meta] as const
export const createdTrigger = triggers.created
export const updatedTrigger = triggers.updated
