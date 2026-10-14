export type CloudflareEmailBindings = {
    /** Name of the `send_email` binding declared in wrangler.jsonc. Defaults to `'EMAIL'`. */
    binding?: string
    /** Optional Discord webhook URL for delivery failure notifications. */
    DISCORD_CF_EMAIL_NOTIFY_WEBHOOK?: string
    /** Extra comma-separated email domains to reject in addition to the built-in disposable-domain list. */
    EMAIL_BLOCKLIST?: string
}
