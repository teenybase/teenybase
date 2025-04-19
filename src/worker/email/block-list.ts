import {HTTPException} from 'hono/http-exception'

export const emailBlockList = 'yopmail.com,mailinator.com,guerrillamail.com,sharklasers.com,maildrop.cc'

export function checkBlocklist(to: string, blocklist?: string) {
    const toOrigin = to.split('@')[1].split('?')[0]
    if (emailBlockList.match(new RegExp('(\,|^)' + toOrigin + '(\,|$)', 'i'))) throw new HTTPException(400, {message: 'Invalid email domain'})
    if (blocklist?.match(new RegExp('(\,|^)' + toOrigin + '(\,|$)', 'i'))) throw new HTTPException(400, {message: 'Invalid email domain'})
}
