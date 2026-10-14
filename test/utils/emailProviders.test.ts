import {describe, expect, test, vi, beforeEach, afterEach} from 'vitest'
import {MailgunHelper} from '../../src/worker/email/mailgun'
import {ResendHelper} from '../../src/worker/email/resend'

// Both helpers call `fetch` against their respective APIs. Tests stub global fetch and inspect the captured request.

const baseSendArgs = {
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 's',
    html: '<p>html</p>',
    tags: [] as any,
}

describe('MailgunHelper.sendEmail — text plumbing', () => {
    let originalFetch: typeof fetch
    let fetchSpy: ReturnType<typeof vi.fn>

    beforeEach(() => {
        originalFetch = globalThis.fetch
        fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({id: 'mg-1'}), {status: 200}))
        globalThis.fetch = fetchSpy as any
    })
    afterEach(() => { globalThis.fetch = originalFetch })

    const newHelper = () => new MailgunHelper({
        MAILGUN_API_KEY: 'k',
        MAILGUN_API_SERVER: 'sandbox.example.com',
    })

    test('appends text field to FormData when provided', async () => {
        await newHelper().sendEmail({...baseSendArgs, text: 'plain body'})
        const [, init] = fetchSpy.mock.calls[0]
        const form = init.body as FormData
        expect(form.get('text')).toBe('plain body')
        expect(form.get('html')).toBe('<p>html</p>')
    })

    test('omits text field when not provided', async () => {
        await newHelper().sendEmail({...baseSendArgs})
        const [, init] = fetchSpy.mock.calls[0]
        const form = init.body as FormData
        expect(form.has('text')).toBe(false)
        expect(form.get('html')).toBe('<p>html</p>')
    })
})

describe('ResendHelper.sendEmail — text plumbing', () => {
    let originalFetch: typeof fetch
    let fetchSpy: ReturnType<typeof vi.fn>

    beforeEach(() => {
        originalFetch = globalThis.fetch
        fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({id: 'rs-1'}), {status: 200}))
        globalThis.fetch = fetchSpy as any
    })
    afterEach(() => { globalThis.fetch = originalFetch })

    const newHelper = () => new ResendHelper({RESEND_API_KEY: 'k'})

    test('includes text in JSON payload when provided', async () => {
        await newHelper().sendEmail({...baseSendArgs, text: 'plain body'})
        const [, init] = fetchSpy.mock.calls[0]
        const body = JSON.parse(init.body as string)
        expect(body.text).toBe('plain body')
        expect(body.html).toBe('<p>html</p>')
    })

    test('omits text from JSON payload when not provided', async () => {
        await newHelper().sendEmail({...baseSendArgs})
        const [, init] = fetchSpy.mock.calls[0]
        const body = JSON.parse(init.body as string)
        expect(body).not.toHaveProperty('text')
        expect(body.html).toBe('<p>html</p>')
    })
})
