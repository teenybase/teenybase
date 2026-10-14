import {z} from 'zod'

export const cloudflareEmailBindingsSchema = z.object({
    binding: z.string().optional(),
    DISCORD_CF_EMAIL_NOTIFY_WEBHOOK: z.string().optional(),
    EMAIL_BLOCKLIST: z.string().optional(),
})
