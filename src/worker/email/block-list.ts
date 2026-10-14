import {HTTPException} from 'hono/http-exception'
import {z} from 'zod'

const defaultBlockedDomains = new Set([
    'yopmail.com', 'mailinator.com', 'guerrillamail.com', 'sharklasers.com', 'maildrop.cc',
    'tempmail.com', 'temp-mail.org', 'throwaway.email', 'trashmail.com', 'trashmail.me',
    'fakeinbox.com', 'mailnesia.com', 'dispostable.com', 'disposablemail.com',
    '10minutemail.com', '10minutemail.net', 'minutemail.com',
    'guerrillamail.info', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.de',
    'grr.la', 'guerrillamailblock.com',
    'mailcatch.com', 'mailmoat.com',
    'tempail.com', 'tempr.email', 'tempinbox.com',
    'getairmail.com', 'mohmal.com', 'harakirimail.com',
    'mailnator.com', 'spamgourmet.com', 'mytemp.email',
    'getnada.com', 'emailondeck.com', 'inboxbear.com',
    'burnermail.io', '33mail.com', 'mailsac.com',

    'temp-mail.io', 'tempemail.cc', 'tmailor.com', '10mail.org',
    '10mail.xyz', 'mailto.plus', 'dropjar.com', 'guysmail.com',
    'fivermail.com', 'gimpmail.com', 'givmail.com', 'chapsmail.com',
    'robot-mail.com', 'clowmail.com', 'replyloop.com',
    'spicysoda.com', 'getmule.com', 'tupmail.com',
    'blondmail.com', 'tafmail.com', 'vomoto.com', 'temptami.com',
])

export function checkBlocklist(to: string, blocklist?: string) {
    z.email().parse(to)
    const domain = to.split('@')[1].toLowerCase()
    if (defaultBlockedDomains.has(domain)) throw new HTTPException(400, {message: 'Invalid email domain'})
    if (blocklist && blocklist.split(',').some(d => d.trim().toLowerCase() === domain)) {
        throw new HTTPException(400, {message: 'Invalid email domain'})
    }
}
