export const passwordProcessors = {
    'sha256': {
        hash: async (password: string, salt: string) => {
            const passText = new TextEncoder().encode((password + salt).normalize())
            const result = await crypto.subtle.digest('SHA-256', passText)
            const hash = new Uint8Array(result)
            return Array.from(hash).map((b) => b.toString(16).padStart(2, '0')).join('')
        },
    }
}
