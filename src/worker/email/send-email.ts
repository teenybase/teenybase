import {MailgunHelper, MailgunProps} from './mailgun'
import {replaceTemplateVariables} from '../util/replaceTemplateVariables'
import {HTTPException} from 'hono/http-exception'
import {baseLayout1} from './templates/base-layout-1'
import {messageLayout1} from './templates/message-layout-1'
import {actionLinkTemplate} from './templates/action-link'
import {actionTextTemplate} from './templates/action-text'
import {baseLayout1Text} from './templates/base-layout-1.text'
import {messageLayout1Text} from './templates/message-layout-1.text'
import {actionLinkTextTemplate} from './templates/action-link.text'
import {actionTextTextTemplate} from './templates/action-text.text'
import {$DBExtension} from '../$DBExtension'
import {$Database} from '../$Database'
import {$Env} from '../env'
import {ResendHelper, ResendProps} from './resend'
import {CloudflareEmailHelper, CloudflareEmailProps} from './cloudflare'
import {HttpRoute} from '../../types/route'

export interface SendEmailProps {
    from: string,
    to: string,
    subject: string,
    html: string,
    /** Plain-text body. Sent alongside `html`; recommended for deliverability and accessibility. */
    text?: string,
    variables: Record<string, string | number | boolean>,
    tags: string[]
}

export interface BaseTemplateProps {
    company_name: string,
    company_url: string,
    company_address: string,
    company_copyright: string,
    support_email: string,

    [key: string]: string,
}

export interface ActionLinkProps {
    message_title: string,
    message_description: string,
    message_footer: string,
    action_link: string,
    action_text?: string,
    action_text_color?: string
    action_button_color?: string
}

export interface ActionTextProps {
    message_title: string,
    message_description: string,
    message_footer: string,
    action_text: string,
    action_text_color?: string
    action_button_color?: string
}

export function buildEmailTemplate(templates: string[]) {
    return templates.reduce((acc, t) => acc.replace('{{EMAIL_CONTENT}}', t), '{{EMAIL_CONTENT}}')
}

/**
 * Layout override accepted by `sendActionLink` / `sendActionText`.
 * - `string | string[]` is treated as an html-only override (legacy form).
 * - `{ html?, text? }` overrides either or both bodies.
 */
export type LayoutOverride =
    | string
    | string[]
    | { html?: string | string[]; text?: string | string[] }

export class EmailSendClient<T extends $Env = $Env> implements $DBExtension<T> {
    private mg: MailgunHelper | null
    private rd: ResendHelper | null
    private cf: CloudflareEmailHelper | null
    private mock: boolean

    routes: HttpRoute[] = []

    constructor(private readonly db: $Database<T>, private props: Partial<SendEmailProps> & {
        variables: BaseTemplateProps
    }, mg?: MailgunProps, rd?: ResendProps, cf?: CloudflareEmailProps, mock = false) {
        this.mg = mg ? new MailgunHelper(mg) : null
        this.rd = rd ? new ResendHelper(rd) : null
        this.cf = cf ? new CloudflareEmailHelper(cf) : null
        this.mock = mock
        // todo also make a webhook that logs everything to an r2 bucket with encryption
        this.mg && this.routes.push(...this.mg.getRoutes(this.db.c))
        this.rd && this.routes.push(...this.rd.getRoutes(this.db.c))
        // Cloudflare binding has no inbound webhook for sends; bounce/delivery telemetry would arrive via Email Routing.
    }

    templates = {
        actionLink: {
            html: [baseLayout1, messageLayout1, actionLinkTemplate],
            text: [baseLayout1Text, messageLayout1Text, actionLinkTextTemplate],
        },
        actionText: {
            html: [baseLayout1, messageLayout1, actionTextTemplate],
            text: [baseLayout1Text, messageLayout1Text, actionTextTextTemplate],
        },
    }

    private resolveTemplates(
        layout: string | string[] | undefined,
        defaults: string[],
        kind: 'html' | 'text',
    ): string[] {
        if (!layout) return defaults
        if (Array.isArray(layout)) return layout
        // Full-document detection: html uses doctype/<html>, text uses the {{EMAIL_CONTENT}} slot.
        if (kind === 'html' && /^\s*(<html|<!doctype)/i.test(layout)) return [layout]
        if (kind === 'text' && layout.includes('{{EMAIL_CONTENT}}')) return [layout]
        // Fragment — wrap in matching layouts.
        return kind === 'html'
            ? [baseLayout1, messageLayout1, layout]
            : [baseLayout1Text, messageLayout1Text, layout]
    }

    private splitLayout(layout: LayoutOverride | undefined): {
        html: string | string[] | undefined,
        text: string | string[] | undefined,
    } {
        if (!layout) return {html: undefined, text: undefined}
        if (typeof layout === 'string' || Array.isArray(layout)) return {html: layout, text: undefined}
        return {html: layout.html, text: layout.text}
    }

    sendActionLink(prop: Partial<SendEmailProps> & { variables: ActionLinkProps }, layout?: LayoutOverride) {
        if (!prop.variables.action_link) throw new Error('action_link is required')
        if (!prop.variables.action_text) prop.variables.action_text = 'Click here'
        const {html: layoutHtml, text: layoutText} = this.splitLayout(layout)
        return this.sendEmail({
            html: buildEmailTemplate(this.resolveTemplates(layoutHtml, this.templates.actionLink.html, 'html')),
            text: buildEmailTemplate(this.resolveTemplates(layoutText, this.templates.actionLink.text, 'text')),
            ...prop,
            tags: ['action-link', ...(prop.tags || [])],
        })
    }

    sendActionText(prop: Partial<SendEmailProps> & { variables: ActionLinkProps }, layout?: LayoutOverride) {
        if (!prop.variables.action_text) throw new Error('action_text is required')
        const {html: layoutHtml, text: layoutText} = this.splitLayout(layout)
        return this.sendEmail({
            html: buildEmailTemplate(this.resolveTemplates(layoutHtml, this.templates.actionText.html, 'html')),
            text: buildEmailTemplate(this.resolveTemplates(layoutText, this.templates.actionText.text, 'text')),
            ...prop,
            tags: ['action-text', ...(prop.tags || [])],
        })
    }

    sendEmail(prop: Partial<SendEmailProps>) {
        const props = {
            ...this.props,
            ...prop,
            variables: {
                ...this.props.variables,
                ...prop.variables,
            } as any | undefined,
            tags: [...(this.props.tags || []), ...(prop.tags || [])],
        }
        if (!props.html) throw new Error('html is required')
        if (!props.subject) throw new Error('html is required')
        if (props.variables) {
            props.html = replaceTemplateVariables(props.html, props.variables, 3)
            if (props.text) props.text = replaceTemplateVariables(props.text, props.variables, 3)
            props.subject = replaceTemplateVariables(props.subject, props.variables, 2)
            delete props.variables
        }
        if (!props.to) throw new Error('to is required')
        if (!props.subject) throw new Error('subject is required')
        if (!props.from) throw new Error('from is required')

        if (this.mock) {
            console.log(`[MockEmail] to=${props.to} subject="${props.subject}"`)
            this.db.c.header('X-Mock-Email', JSON.stringify({to: props.to, subject: props.subject, html: props.html, text: props.text}), {append: true})
            return
        } else if (this.mg) {
            return this.mg.sendEmail({
                from: props.from,
                html: props.html,
                text: props.text,
                subject: props.subject,
                tags: props.tags || [],
                to: props.to,
            })
        } else if (this.rd) {
            return this.rd.sendEmail({
                from: props.from,
                html: props.html,
                text: props.text,
                subject: props.subject,
                tags: props.tags.map(t => ({name: t, value: 'true'})) || [],
                to: props.to,
            })
        } else if (this.cf) {
            return this.cf.sendEmail({
                from: props.from,
                html: props.html,
                text: props.text,
                subject: props.subject,
                tags: props.tags || [],
                to: props.to,
            })
        } else
            throw new HTTPException(500, {message: 'Email provider not configured'})
    }

}
