import {Hono} from 'hono'
import {HTTPException} from 'hono/http-exception'
import {MailgunHelper} from './mailgun'
import {MailgunBindings} from '../../types/mailgun'

export type MailgunEnv = MailgunBindings & {
    MAILGUN_WEBHOOK_ID?: string // (optional). custom so it cannot be guessed and spammed
}

type ContextEnv = {
    Bindings: MailgunEnv,
    Variables: {
        mailgun: MailgunHelper
    }
}
export const mailgunApi = new Hono<ContextEnv>()

mailgunApi.use('/*', async (c, next) => {
    c.set('mailgun', new MailgunHelper(c.env))
    return next()
})

// todo also make a webhook that logs everything to an r2 bucket (with encryption)
mailgunApi.on(['GET', 'POST'],
    '/webhook/:wid?',
    async (c) => {
        const wid = c.req.param('wid')
        if((c.env.MAILGUN_WEBHOOK_ID || wid) && wid !== c.env.MAILGUN_WEBHOOK_ID) throw new HTTPException(404, {message: 'Not found'})
        const mailgun = c.get('mailgun')
        const body = JSON.parse((await c.req.text()) || '{}')
        // console.log(JSON.stringify({...c.req.raw.headers}))
        // c.req.raw.headers.forEach((v, k) => {
        //     console.log('header', k, v)
        // })
        // console.log(body, c.req.url)
        await mailgun.receiveWebhook(body)
        return c.json({message: 'Received'}, 200);
    }
);

mailgunApi.get('*', async (c) => {
    return c.json({error: 'Not found'}, 404)
})
