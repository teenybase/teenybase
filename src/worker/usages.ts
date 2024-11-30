export enum TableFieldUsageRecord {
    record_uid = 'record_uid',
    record_created = 'record_created',
    record_updated = 'record_updated',
}

export const noUpdateSetUsagesRecord: TableFieldUsageRecord[] = [TableFieldUsageRecord.record_created, TableFieldUsageRecord.record_updated]
export const noInsertSetUsagesRecord: TableFieldUsageRecord[] = [TableFieldUsageRecord.record_created, TableFieldUsageRecord.record_updated]
export const noSelectFieldsUsagesRecord: TableFieldUsageRecord[] = [] // not for admin...

export enum TableFieldUsageAuth {
    auth_username = 'auth_username',
    auth_email = 'auth_email',
    auth_email_verified = 'auth_email_verified',
    auth_password = 'auth_password',
    auth_password_salt = 'auth_password_salt',
    auth_name = 'auth_name',
    auth_avatar = 'auth_avatar',
    auth_audience = 'auth_audience',
    auth_metadata = 'auth_metadata',
    // auth_reset_sent_at = 'auth_reset_sent_at',
    // auth_verification_sent_at = 'auth_verification_sent_at',
}
export const noUpdateSetUsagesAuth: TableFieldUsageAuth[] = [TableFieldUsageAuth.auth_email, TableFieldUsageAuth.auth_email_verified, TableFieldUsageAuth.auth_password_salt]
export const noInsertSetUsagesAuth: TableFieldUsageAuth[] = [TableFieldUsageAuth.auth_email_verified, TableFieldUsageAuth.auth_password_salt]
// not for admin...
export const noSelectFieldsUsagesAuth: TableFieldUsageAuth[] = [TableFieldUsageAuth.auth_password, TableFieldUsageAuth.auth_password_salt]

export type TableFieldUsage = keyof typeof TableFieldUsageRecord | keyof typeof TableFieldUsageAuth

export const noUpdateSetUsages: string[] = [...noUpdateSetUsagesRecord, ...noUpdateSetUsagesAuth]
export const noInsertSetUsages: string[] = [...noInsertSetUsagesRecord, ...noInsertSetUsagesAuth]
// not for admin...
export const noSelectFieldsUsages: string[] = [...noSelectFieldsUsagesRecord, ...noSelectFieldsUsagesAuth]

