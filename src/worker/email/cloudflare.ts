import {HTTPException} from 'hono/http-exception'
import {discordNotify} from './discordNotify'
import {CloudflareEmailBindings} from '../../types/cloudflare-email'
import {checkBlocklist} from './block-list'
import {Context} from 'hono'
import {HttpRoute} from '../../types/route'

export type CFSendEmailProps = {
    from: string
    to: string
    subject: string
    html: string
    text?: string
    /** Ignored — the Cloudflare Email Service binding does not support tags. */
    tags?: string[]
}

/** Minimal shape of the Cloudflare Email Service `send_email` binding. */
export interface CloudflareSendEmailBinding {
    send(options: {
        to: string
        // An object needs both fields: workerd rejects `{email}` without a name ("Incorrect type for the 'name'
        // field on 'EmailAddress'"). A bare address is passed as a plain string.
        from: string | {email: string, name: string}
        replyTo?: string | {email: string, name: string}
        subject: string
        html?: string
        text?: string
    }): Promise<{messageId?: string} | void>
}

export interface CloudflareEmailProps extends Omit<CloudflareEmailBindings, 'binding'> {
    /** Resolves the `send_email` binding from the worker env at send-time. */
    binding: () => CloudflareSendEmailBinding | undefined
    /** Name of the binding (for error messages). */
    bindingName: string
}

/** "Name <addr>" → {name, email}; a bare "addr" stays a string (the binding requires `name` whenever it gets an object). */
function parseFromAddress(from: string): string | {email: string, name: string} {
    const m = from.match(/^\s*(.+?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/)
    if (m) return {name: m[1], email: m[2]}
    const bare = from.trim()
    if (!bare.includes('@')) {
        throw new HTTPException(400, {message: `Invalid from address: ${from}`})
    }
    return bare
}

export class CloudflareEmailHelper {
    private bindings: CloudflareEmailProps

    constructor(bindings: CloudflareEmailProps) {
        this.bindings = bindings
    }

    async sendEmail({from, to, subject, html, text}: CFSendEmailProps) {
        checkBlocklist(to, this.bindings.EMAIL_BLOCKLIST)

        const binding = this.bindings.binding()
        if (!binding || typeof binding.send !== 'function') {
            throw new HTTPException(500, {
                message: `Cloudflare Email binding '${this.bindings.bindingName}' not found on env. Add \`"send_email": [{ "name": "${this.bindings.bindingName}" }]\` to wrangler.jsonc and onboard the sending domain with \`npx wrangler email sending enable <yourdomain>\`.`,
            })
        }

        const fromParsed = parseFromAddress(from)

        try {
            return await binding.send({
                to,
                from: fromParsed,
                subject,
                html,
                ...(text ? {text} : {}),
            })
        } catch (e: any) {
            const msg = e?.message || String(e)
            console.error('Failed to send email via Cloudflare', msg)
            if (this.bindings.DISCORD_CF_EMAIL_NOTIFY_WEBHOOK) {
                await discordNotify(
                    this.bindings.DISCORD_CF_EMAIL_NOTIFY_WEBHOOK,
                    `Failed to send email to \`${to}\` via Cloudflare Email Service\n\`\`\`${msg}\`\`\``,
                )
            }
            throw new HTTPException(500, {message: 'Failed to send email'})
        }
    }

    // Cloudflare Email Service has no inbound webhook for the send_email binding.
    // Bounce/delivery telemetry would arrive via Email Routing (separate feature).
    getRoutes(_c: Context): HttpRoute[] {
        return []
    }
}
