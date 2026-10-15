import {TableFieldData} from '../field'
import {TableFieldUsageAuth} from '../../worker/usages'

/**
 * Password hash and salt columns of an auth table. They are never returned by a select or `returning` and can't be
 * referenced in a where/rule expression, admin requests included (Pocket UI viewer/editor logins are admin tokens).
 * Only the auth extension reads them, through its own queries.
 */
export function isAuthSecretField(f: Pick<TableFieldData, 'usage'>) {
    return f.usage === TableFieldUsageAuth.auth_password || f.usage === TableFieldUsageAuth.auth_password_salt
}

/** Whether a request may read this column: never for auth secrets, only for admins when `noSelect`. */
export function isFieldSelectable(f: Pick<TableFieldData, 'usage' | 'noSelect'>, isAdmin: boolean) {
    return !isAuthSecretField(f) && (isAdmin || !f.noSelect)
}
