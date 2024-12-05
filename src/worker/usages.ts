export enum TableFieldUsageRecord {
    record_uid = 'record_uid',
    record_created = 'record_created',
    record_updated = 'record_updated',
}

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
export type TableFieldUsage = keyof typeof TableFieldUsageRecord | keyof typeof TableFieldUsageAuth

