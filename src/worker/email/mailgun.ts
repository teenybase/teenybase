import {HTTPException} from 'hono/http-exception'
import {discordNotify} from './discordNotify'
import {MailgunBindings} from '../../types/mailgun'

export type MGSendEmailProps = {
    from: string, to: string,
    subject: string,
    html: string,
    tags: string[]
}
const emailBlockList = 'yopmail.com,mailinator.com,guerrillamail.com,sharklasers.com'

export class MailgunHelper{
    baseUrl = 'https://api.mailgun.net/v3/'
    private bindings: MailgunBindings

    constructor(bindings: MailgunBindings) {
        this.bindings = bindings
        if(bindings.MAILGUN_API_URL?.startsWith('https://')) this.baseUrl = bindings.MAILGUN_API_URL
        else if(bindings.MAILGUN_API_URL) throw new HTTPException(400, {message: 'Invalid mailgun configuration'})
        if(!this.bindings.MAILGUN_API_SERVER || !this.bindings.MAILGUN_API_KEY) throw new HTTPException(400, {message: 'Invalid mailgun configuration'})
    }

    async sendEmail({from, to, subject, html, tags}: MGSendEmailProps){
        const toOrigin = to.split('@')[1].split('?')[0]
        if(emailBlockList.match(new RegExp('(\,|^)' + toOrigin + '(\,|$)', 'i'))) throw new HTTPException(400, {message: 'Invalid email domain'})
        if(this.bindings.EMAIL_BLOCKLIST?.match(new RegExp('(\,|^)' + toOrigin + '(\,|$)', 'i'))) throw new HTTPException(400, {message: 'Invalid email domain'})

        const form = new FormData();
        form.append('from', from)
        form.append('to', to)
        form.append('subject', subject)
        form.append('html', html)
        // form.append('h:X-Mailgun-Variables', JSON.stringify(variables))
        tags.forEach(tag => form.append('o:tag', tag))

        const res = await fetch(this.baseUrl + this.bindings.MAILGUN_API_SERVER + '/messages', {
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + btoa('api:' + this.bindings.MAILGUN_API_KEY),
                // dont add content-type header for multipart
            },
            body: form
        });
        if(!res.ok) {
            const resp = await res.text()
            console.error('Error sending email, ', res.status, resp)
            if(this.bindings.DISCORD_MAILGUN_NOTIFY_WEBHOOK)
                await discordNotify(this.bindings.DISCORD_MAILGUN_NOTIFY_WEBHOOK, `Failed to send email(\`${res.status}\`) to \`${to}\` \n\`\`\`${resp}\`\`\``)
            throw new HTTPException(500, {message: 'Failed to send email'})
        }
        return await res.json() as any
    }

    async receiveWebhook(data: any){
        const key = this.bindings.MAILGUN_WEBHOOK_SIGNING_KEY
        const signature = data.signature
        const verified = (!key || !signature) ? false : await verify({signingKey: key, ...signature})
        let message = ''
        if(!verified) {
            console.error('Invalid Webhook Signature', JSON.stringify(data))
            message += '[Invalid Webhook Signature]\n'
        }

        const eventData = data['event-data']

        // mailgun is sending empty GET request for some reason...
        if(!eventData && !verified){
            if(this.bindings.DISCORD_MAILGUN_NOTIFY_WEBHOOK)
                await discordNotify(this.bindings.DISCORD_MAILGUN_NOTIFY_WEBHOOK, `Empty webhook notification from mailgun, make sure https is used in webhook. https://app.mailgun.com/mg/sending/${this.bindings.MAILGUN_API_SERVER}/logs`)
            return
        }
        if(!eventData) throw new HTTPException(400, {message: 'Invalid mailgun webhook data'})
        const timestamp = eventData.timestamp ?? Date.now()
        const logLevel = eventData['log-level']
        const event = eventData.event
        const recipient = eventData.recipient
        message += `${logLevel?.toUpperCase()||'UNKNOWN'} - ${event?.toUpperCase()||'UNKNOWN'} at ${new Date(parseInt(timestamp) * 1000).toISOString()}\n`
        if(event.toLowerCase() === 'failed'){
            message += `Severity: ${eventData.severity}\n`
            message += `Reason: ${eventData.reason}\n`
        }
        if(recipient) message += `Recipient: ${eventData.recipient}\n`

        if(logLevel !== 'info'){
            const json = JSON.stringify(eventData, null, 2)
            const res = this.bindings.DISCORD_MAILGUN_NOTIFY_WEBHOOK ? await discordNotify(this.bindings.DISCORD_MAILGUN_NOTIFY_WEBHOOK, message, [new File([json], 'event.json', {
                type: 'application/json',
            })]) : false // todo - notify by email if no discord?
            if(!res){
                logLevel === 'warn' ? console.warn(message, json) : console.error(message, json)
                if(this.bindings.DISCORD_MAILGUN_NOTIFY_WEBHOOK)
                    throw new HTTPException(406, {message: 'Failed to notify destination'})
            }
        }else {
            // todo batch cache
            console.log(message)
        }
        if(!verified) throw new HTTPException(406, {message: 'Invalid mailgun webhook signature' + key?'':', no key to verify'})
    }
}

interface VerifyParams {
    signingKey: string;
    timestamp: string;
    token: string;
    signature: string;
}

async function verify({ signingKey, timestamp, token, signature }: VerifyParams): Promise<boolean> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(signingKey);
    const message = encoder.encode(timestamp + token);

    const key = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign(
        'HMAC',
        key,
        message
    );

    const signatureArray = Array.from(new Uint8Array(signatureBuffer));
    const encodedToken = signatureArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return encodedToken === signature;
}
