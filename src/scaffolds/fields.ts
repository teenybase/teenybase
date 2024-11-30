import {TableFieldData} from '../types/field'
import {TableFieldUsageAuth, TableFieldUsageRecord} from '../worker/usages'
import {TableFieldDataType, TableFieldSqlDataType0, TableFieldSqlDataType1} from "../types/dataTypes";

export const baseFields: TableFieldData[] = [
    {name: "id", primary: true, type: TableFieldDataType.text, sqlType: TableFieldSqlDataType0.text, notNull: true, usage: TableFieldUsageRecord.record_uid, noUpdate: true},
    {name: "created", type: TableFieldDataType.date, sqlType: TableFieldSqlDataType1.timestamp, default: `CURRENT_TIMESTAMP`, notNull: true, usage: TableFieldUsageRecord.record_created},
    {name: "updated", type: TableFieldDataType.date, sqlType: TableFieldSqlDataType1.timestamp, default: `CURRENT_TIMESTAMP`, notNull: true, usage: TableFieldUsageRecord.record_updated}
]

export const authFields: TableFieldData[] = [
    {name: "username", type: TableFieldDataType.text, sqlType: TableFieldSqlDataType0.text, notNull: true, unique: true, usage: TableFieldUsageAuth.auth_username},
    {name: "email", type: TableFieldDataType.text, sqlType: TableFieldSqlDataType0.text, notNull: true, unique: true, usage: TableFieldUsageAuth.auth_email},
    {name: "email_verified", type: TableFieldDataType.bool, sqlType: TableFieldSqlDataType1.boolean, notNull: true, default: 'false', usage: TableFieldUsageAuth.auth_email_verified},
    {name: "password", type: TableFieldDataType.text, sqlType: TableFieldSqlDataType0.text, notNull: true, usage: TableFieldUsageAuth.auth_password},
    {name: "password_salt", type: TableFieldDataType.text, sqlType: TableFieldSqlDataType0.text, notNull: true, usage: TableFieldUsageAuth.auth_password_salt},
    {name: "name", type: TableFieldDataType.text, sqlType: TableFieldSqlDataType0.text, notNull: true, usage: TableFieldUsageAuth.auth_name},
    {name: "avatar", sqlType: TableFieldSqlDataType0.text, type: TableFieldDataType.file, usage: TableFieldUsageAuth.auth_avatar},
    {name: "role", type: TableFieldDataType.text, sqlType: TableFieldSqlDataType0.text, usage: TableFieldUsageAuth.auth_audience},
    {name: "meta", type: TableFieldDataType.json, sqlType: TableFieldSqlDataType1.json, usage: TableFieldUsageAuth.auth_metadata},
]
