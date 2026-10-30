import {describe, expect, test, vi, beforeEach, afterEach} from 'vitest'
import {EmailSendClient} from '../../src/worker/email/send-email'

// Stubs the minimum surface of $Database that EmailSendClient touches: a Hono-like `c.header`.
// mock=true path captures html/text into X-Mock-Email header without invoking real providers.

function makeClient(opts: {
    mock?: boolean,
    mg?: any,
    rd?: any,
    cf?: any,
}) {
    const headerCalls: Array<{name: string, value: string}> = []
    const c: any = {
        header: (name: string, value: string) => {
            headerCalls.push({name, value})
        },
        env: {},
    }
    const db: any = {c}
    const client = new EmailSendClient(db, {
        from: 'sender@example.com',
        variables: {
            company_name: 'C',
            company_url: 'https://example.com',
            company_address: 'addr',
            company_copyright: '2026',
            support_email: 'support@example.com',
        },
        tags: [],
    }, opts.mg, opts.rd, opts.cf, opts.mock ?? false)

    const lastMockEmail = () => {
        const last = [...headerCalls].reverse().find(h => h.name === 'X-Mock-Email')
        return last ? JSON.parse(last.value) : undefined
    }
    return {client, headerCalls, lastMockEmail, c}
}

const linkVars = {
    message_title: 'Title',
    message_description: 'Desc',
    message_footer: 'Footer',
    action_link: 'https://example.com/go',
    action_text: 'Click Me',
}

describe('EmailSendClient LayoutOverride', () => {
    test('undefined layout → default html and default text bodies', async () => {
        const {client, lastMockEmail} = makeClient({mock: true})
        await client.sendActionLink({to: 'u@x.com', subject: 's', variables: linkVars})
        const m = lastMockEmail()
        // Default html contains the action button table
        expect(m.html).toContain('<a href="https://example.com/go"')
        // Default text contains the action line
        expect(m.text).toContain('Click Me: https://example.com/go')
        // Text body has structural newlines (full layout was applied)
        expect(m.text.split('\n').length).toBeGreaterThan(5)
    })

    test('legacy string form overrides html only; text falls back to default', async () => {
        const {client, lastMockEmail} = makeClient({mock: true})
        await client.sendActionLink({
            to: 'u@x.com', subject: 's', variables: linkVars,
        }, '<p>fragment html</p>')
        const m = lastMockEmail()
        // html was wrapped: contains the fragment INSIDE the default base+message layout
        expect(m.html).toContain('<p>fragment html</p>')
        expect(m.html).toContain('Problems or questions?') // default footer chrome
        // text still uses default
        expect(m.text).toContain('Click Me: https://example.com/go')
    })

    test('legacy string[] form is used as-is for html', async () => {
        const {client, lastMockEmail} = makeClient({mock: true})
        await client.sendActionLink({
            to: 'u@x.com', subject: 's', variables: linkVars,
        }, ['<full>{{message_title}}</full>'])
        const m = lastMockEmail()
        expect(m.html).toBe('<full>Title</full>')
        // text untouched
        expect(m.text).toContain('Click Me')
    })

    test('{html} only → custom html, default text', async () => {
        const {client, lastMockEmail} = makeClient({mock: true})
        await client.sendActionLink({
            to: 'u@x.com', subject: 's', variables: linkVars,
        }, {html: '<p>custom</p>'})
        const m = lastMockEmail()
        expect(m.html).toContain('<p>custom</p>')
        expect(m.text).toContain('Click Me: https://example.com/go')
    })

    test('{text} only → default html, custom text', async () => {
        const {client, lastMockEmail} = makeClient({mock: true})
        await client.sendActionLink({
            to: 'u@x.com', subject: 's', variables: linkVars,
        }, {text: '{{message_title}} | {{action_link}}'})
        const m = lastMockEmail()
        // html got default chrome
        expect(m.html).toContain('Problems or questions?')
        // text is the wrapped fragment (since no {{EMAIL_CONTENT}} marker, gets wrapped in layouts)
        expect(m.text).toContain('Title | https://example.com/go')
        expect(m.text).toContain('Problems or questions?')
    })

    test('{html, text} → both custom', async () => {
        const {client, lastMockEmail} = makeClient({mock: true})
        await client.sendActionLink({
            to: 'u@x.com', subject: 's', variables: linkVars,
        }, {
            html: '<p>custom html: {{action_link}}</p>',
            text: 'CUSTOM: {{action_link}}',
        })
        const m = lastMockEmail()
        expect(m.html).toContain('custom html: https://example.com/go')
        // Text fragment gets wrapped in default text layouts (no {{EMAIL_CONTENT}} marker present)
        expect(m.text).toContain('CUSTOM: https://example.com/go')
    })

    test('html string with <!doctype skips wrap (full-document detection)', async () => {
        const {client, lastMockEmail} = makeClient({mock: true})
        await client.sendActionLink({
            to: 'u@x.com', subject: 's', variables: linkVars,
        }, {html: '<!doctype html><html><body>{{action_link}}</body></html>'})
        const m = lastMockEmail()
        expect(m.html).toBe('<!doctype html><html><body>https://example.com/go</body></html>')
        // No "Problems or questions?" chrome — full doc was used as-is
        expect(m.html).not.toContain('Problems or questions?')
    })

    test('text string containing {{EMAIL_CONTENT}} is used as-is (text full-doc detection)', async () => {
        const {client, lastMockEmail} = makeClient({mock: true})
        await client.sendActionLink({
            to: 'u@x.com', subject: 's', variables: linkVars,
        }, {text: 'HEAD\n{{EMAIL_CONTENT}}\nTAIL'})
        const m = lastMockEmail()
        // {{EMAIL_CONTENT}} placeholder is preserved (buildEmailTemplate's outer reducer leaves it
        // since there's no second template to substitute in). Then replaceTemplateVariables can't
        // find it as a variable, so it remains. The point being tested: no wrapping in defaults.
        expect(m.text).not.toContain('Problems or questions?')
        expect(m.text.startsWith('HEAD')).toBe(true)
    })
})

describe('EmailSendClient provider precedence', () => {
    let originalFetch: typeof fetch
    let fetchSpy: ReturnType<typeof vi.fn>

    beforeEach(() => {
        originalFetch = globalThis.fetch
        fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({id: 'x'}), {status: 200}))
        globalThis.fetch = fetchSpy as any
    })
    afterEach(() => { globalThis.fetch = originalFetch })

    test('mailgun fires when mg+rd+cf are all configured', async () => {
        const cfSend = vi.fn().mockResolvedValue({messageId: 'cf-1'})
        const {client} = makeClient({
            mock: false,
            mg: {MAILGUN_API_KEY: 'k', MAILGUN_API_SERVER: 'sandbox.example.com'},
            rd: {RESEND_API_KEY: 'k'},
            cf: {binding: () => ({send: cfSend}), bindingName: 'EMAIL'},
        })
        await client.sendActionLink({to: 'u@example.com', subject: 's', variables: linkVars})
        // Mailgun URL contains /messages
        expect(fetchSpy).toHaveBeenCalledTimes(1)
        const [url] = fetchSpy.mock.calls[0]
        expect(String(url)).toContain('mailgun')
        expect(cfSend).not.toHaveBeenCalled()
    })

    test('resend fires when only rd+cf are configured', async () => {
        const cfSend = vi.fn().mockResolvedValue({messageId: 'cf-1'})
        const {client} = makeClient({
            mock: false,
            rd: {RESEND_API_KEY: 'k'},
            cf: {binding: () => ({send: cfSend}), bindingName: 'EMAIL'},
        })
        await client.sendActionLink({to: 'u@example.com', subject: 's', variables: linkVars})
        expect(fetchSpy).toHaveBeenCalledTimes(1)
        const [url] = fetchSpy.mock.calls[0]
        expect(String(url)).toContain('resend')
        expect(cfSend).not.toHaveBeenCalled()
    })

    test('cloudflare fires when only cf is configured', async () => {
        const cfSend = vi.fn().mockResolvedValue({messageId: 'cf-1'})
        const {client} = makeClient({
            mock: false,
            cf: {binding: () => ({send: cfSend}), bindingName: 'EMAIL'},
        })
        await client.sendActionLink({to: 'u@example.com', subject: 's', variables: linkVars})
        expect(cfSend).toHaveBeenCalledTimes(1)
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    test('throws when no provider is configured and mock is false', () => {
        const {client} = makeClient({mock: false})
        // sendEmail throws synchronously when all provider branches fall through.
        expect(() =>
            client.sendActionLink({to: 'u@example.com', subject: 's', variables: linkVars})
        ).toThrow(/Email provider not configured/)
    })
})

describe('EmailSendClient mock routing', () => {
    // The mock path returns the rendered email (with verify/reset tokens) in a response header,
    // so only `mock: true` may take it; no recipient address can opt itself in.
    test('with mock off, an e2e-*@teenybase.work recipient goes to the provider, not the header', async () => {
        const send = vi.fn(async () => ({messageId: 'm1'}))
        const {client, headerCalls} = makeClient({mock: false, cf: {binding: () => ({send})}})
        await client.sendActionLink({to: 'e2e-attacker@teenybase.work', subject: 's', variables: linkVars})
        expect(send).toHaveBeenCalledTimes(1)
        expect(headerCalls.find(h => h.name === 'X-Mock-Email')).toBeUndefined()
    })

    test('with mock on, any recipient is captured in the header and no provider is called', async () => {
        const send = vi.fn(async () => ({messageId: 'm1'}))
        const {client, lastMockEmail} = makeClient({mock: true, cf: {binding: () => ({send})}})
        await client.sendActionLink({to: 'u@x.com', subject: 's', variables: linkVars})
        expect(send).not.toHaveBeenCalled()
        expect(lastMockEmail().to).toBe('u@x.com')
    })
})
