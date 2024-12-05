import {MailgunHelper} from './mailgun'
import {replaceTemplateVariables} from '../util/replaceTemplateVariables'
import {HTTPException} from 'hono/http-exception'
import {baseLayout1} from './templates/base-layout-1'
import {messageLayout1} from './templates/message-layout-1'
import {actionLinkTemplate} from './templates/action-link'
import {actionTextTemplate} from './templates/action-text'
import {MailgunBindings} from '../../types/mailgun'
import {$DBExtension} from '../$DBExtension'
import {$Database} from '../$Database'
import {z} from 'zod'

export interface SendEmailProps {
    from: string,
    to: string,
    subject: string,
    html: string,
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

function buildEmailTemplate(templates: string[]) {
    return templates.reduce((acc, t) => acc.replace('{{EMAIL_CONTENT}}', t), '{{EMAIL_CONTENT}}')
}

export class EmailSendClient extends $DBExtension {
    private mg: MailgunHelper | null

    constructor(db: $Database<any>, private props: Partial<SendEmailProps> & {
        variables: BaseTemplateProps
    }, mg?: MailgunBindings) {
        super(db)
        this.mg = mg ? new MailgunHelper(mg) : null
        // todo also make a webhook that logs everything to an r2 bucket (with encryption)
        this.mg && this.routes.push(...this.mg.getRoutes(this.db.c))
    }

    templates = {
        actionLink: [baseLayout1, messageLayout1, actionLinkTemplate],
        actionText: [baseLayout1, messageLayout1, actionTextTemplate],
    }

    sendActionLink(prop: Partial<SendEmailProps> & { variables: ActionLinkProps }) {
        if (!prop.variables.action_link) throw new Error('action_link is required')
        if (!prop.variables.action_text) prop.variables.action_text = 'Click here'
        return this.sendEmail({
            html: buildEmailTemplate(this.templates.actionLink),
            ...prop,
            tags: ['action-link', ...(prop.tags || [])],
        })
    }

    sendActionText(prop: Partial<SendEmailProps> & { variables: ActionLinkProps }) {
        if (!prop.variables.action_text) throw new Error('action_text is required')
        return this.sendEmail({
            html: buildEmailTemplate(this.templates.actionLink),
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
            props.html = replaceTemplateVariables(props.html, props.variables, 2)
            props.subject = replaceTemplateVariables(props.subject, props.variables, 1)
            delete props.variables
        }
        if (!props.to) throw new Error('to is required')
        if (!props.subject) throw new Error('subject is required')
        if (!props.from) throw new Error('from is required')
        if (!this.mg) throw new HTTPException(500, {message: 'Mailgun not configured'})
        return this.mg.sendEmail({
            from: props.from,
            html: props.html,
            subject: props.subject,
            tags: props.tags || [],
            to: props.to,
        })
    }


}

