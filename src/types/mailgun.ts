export type MailgunBindings = {
    MAILGUN_API_KEY: string
    MAILGUN_API_SERVER: string
    MAILGUN_API_URL?: string
    MAILGUN_WEBHOOK_ID?: string // (optional). custom so it cannot be guessed and spammed
    MAILGUN_WEBHOOK_SIGNING_KEY?: string
    DISCORD_MAILGUN_NOTIFY_WEBHOOK?: string
    EMAIL_BLOCKLIST?: string // comma separated list of domains
}

