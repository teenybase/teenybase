import {describe, expect, test, vi, beforeEach, afterEach} from 'vitest'
import {CloudflareEmailHelper} from '../../src/worker/email/cloudflare'
import {HTTPException} from 'hono/http-exception'

const okBinding = () => ({send: vi.fn().mockResolvedValue({messageId: 'msg-123'})})

const baseSendArgs = {
    to: 'user@example.com',
    subject: 'subject',
    html: '<p>html</p>',
}

describe('CloudflareEmailHelper', () => {
    let originalFetch: typeof fetch
    beforeEach(() => {
        originalFetch = globalThis.fetch
    })
    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    test('parses "Name <addr>" form', async () => {
        const bind = okBinding()
        const h = new CloudflareEmailHelper({binding: () => bind, bindingName: 'EMAIL'})
        await h.sendEmail({...baseSendArgs, from: 'My App <app@example.com>'})
        expect(bind.send).toHaveBeenCalledWith(expect.objectContaining({
            from: {name: 'My App', email: 'app@example.com'},
        }))
    })

    test('trims whitespace around name', async () => {
        const bind = okBinding()
        const h = new CloudflareEmailHelper({binding: () => bind, bindingName: 'EMAIL'})
        await h.sendEmail({...baseSendArgs, from: '  John  <a@b.com>  '})
        expect(bind.send).toHaveBeenCalledWith(expect.objectContaining({
            from: {name: 'John', email: 'a@b.com'},
        }))
    })

    test('accepts bare email (no name)', async () => {
        const bind = okBinding()
        const h = new CloudflareEmailHelper({binding: () => bind, bindingName: 'EMAIL'})
        await h.sendEmail({...baseSendArgs, from: 'bare@example.com'})
        expect(bind.send).toHaveBeenCalledWith(expect.objectContaining({
            from: {email: 'bare@example.com'},
        }))
        // No `name` key when not provided.
        const call = (bind.send as any).mock.calls[0][0]
        expect(call.from).not.toHaveProperty('name')
    })

    test('rejects invalid from address (no @)', async () => {
        const h = new CloudflareEmailHelper({binding: () => okBinding(), bindingName: 'EMAIL'})
        await expect(h.sendEmail({...baseSendArgs, from: 'not-an-email'}))
            .rejects.toThrow(HTTPException)
    })

    test('passes text when provided and returns binding result', async () => {
        const bind = okBinding()
        const h = new CloudflareEmailHelper({binding: () => bind, bindingName: 'EMAIL'})
        const result = await h.sendEmail({...baseSendArgs, from: 'a@x.com', text: 'plain body'})
        expect(bind.send).toHaveBeenCalledWith(expect.objectContaining({text: 'plain body'}))
        expect(result).toEqual({messageId: 'msg-123'})
    })

    test('omits text key when not provided', async () => {
        const bind = okBinding()
        const h = new CloudflareEmailHelper({binding: () => bind, bindingName: 'EMAIL'})
        await h.sendEmail({...baseSendArgs, from: 'a@x.com'})
        const call = (bind.send as any).mock.calls[0][0]
        expect(call).not.toHaveProperty('text')
    })

    test('throws clear error when binding resolver returns undefined OR lacks .send()', async () => {
        // Same code path; one assertion verifies both inputs converge.
        const h1 = new CloudflareEmailHelper({binding: () => undefined, bindingName: 'EMAIL'})
        await expect(h1.sendEmail({...baseSendArgs, from: 'a@x.com'}))
            .rejects.toThrow(/binding 'EMAIL' not found/)

        const h2 = new CloudflareEmailHelper({binding: () => ({} as any), bindingName: 'EMAIL'})
        await expect(h2.sendEmail({...baseSendArgs, from: 'a@x.com'}))
            .rejects.toThrow(/binding 'EMAIL' not found/)
    })

    test('default blocklist rejects disposable domain', async () => {
        const h = new CloudflareEmailHelper({binding: () => okBinding(), bindingName: 'EMAIL'})
        await expect(h.sendEmail({...baseSendArgs, from: 'a@x.com', to: 'foo@yopmail.com'}))
            .rejects.toThrow(/Invalid email domain/)
    })

    test('custom EMAIL_BLOCKLIST rejects matching domain', async () => {
        const h = new CloudflareEmailHelper({
            binding: () => okBinding(),
            bindingName: 'EMAIL',
            EMAIL_BLOCKLIST: 'banned.com,other.com',
        })
        await expect(h.sendEmail({...baseSendArgs, from: 'a@x.com', to: 'foo@banned.com'}))
            .rejects.toThrow(/Invalid email domain/)
    })

    test('binding.send() failure throws 500 and notifies Discord when webhook is set', async () => {
        const bind = {send: vi.fn().mockRejectedValue(new Error('boom'))}
        // discordNotify calls global fetch — stub it to inspect.
        const fetchSpy = vi.fn().mockResolvedValue(new Response('', {status: 200}))
        globalThis.fetch = fetchSpy as any

        const h = new CloudflareEmailHelper({
            binding: () => bind,
            bindingName: 'EMAIL',
            DISCORD_CF_EMAIL_NOTIFY_WEBHOOK: 'https://discord.com/api/webhooks/fake/url',
        })

        await expect(h.sendEmail({...baseSendArgs, from: 'a@x.com'}))
            .rejects.toThrow(/Failed to send email/)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
        const [url] = fetchSpy.mock.calls[0]
        expect(url).toBe('https://discord.com/api/webhooks/fake/url')
    })

    test('binding.send() failure does not call fetch when no Discord webhook is set', async () => {
        const bind = {send: vi.fn().mockRejectedValue(new Error('boom'))}
        const fetchSpy = vi.fn()
        globalThis.fetch = fetchSpy as any

        const h = new CloudflareEmailHelper({binding: () => bind, bindingName: 'EMAIL'})
        await expect(h.sendEmail({...baseSendArgs, from: 'a@x.com'}))
            .rejects.toThrow(/Failed to send email/)
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    test('getRoutes returns empty array (no webhook surface)', () => {
        const h = new CloudflareEmailHelper({binding: () => okBinding(), bindingName: 'EMAIL'})
        expect(h.getRoutes({} as any)).toEqual([])
    })
})
