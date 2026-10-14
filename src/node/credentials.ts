import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import colors from 'picocolors'
import {Logger} from './logger'

/**
 * Server for `register` / `login`: `--server`, then the TEENYBASE_URL env var, then the server of the
 * saved credentials (re-login). There is no built-in default: the CLI never talks to a hosted
 * service unless the user pointed it at one.
 */
export function resolveServerUrl(explicit?: string): string {
    const fromCreds = (() => {
        try {
            return loadCredentials()?.serverUrl
        } catch {
            return undefined
        }
    })()
    const url = (explicit || process.env.TEENYBASE_URL || fromCreds || '').trim().replace(/\/+$/, '')
    if (!url) throw new Error('No Teenybase server set. Pass --server <url> or set the TEENYBASE_URL environment variable.')
    return url
}
export const NOT_LOGGED_IN_ERROR = 'Not logged in. Run "teeny register" or "teeny login" first.'

export class CredentialMismatchError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'CredentialMismatchError'
    }
}

export interface Credentials {
    serverUrl: string
    email: string
    apiToken: string
    /** Refresh token for auto-refreshing expired platform JWTs */
    refreshToken?: string
    /** Teenybase user ID (used for tb-{userId} account_id) */
    userId?: string
    /** Platform username (used for user-scoped gateway URLs) */
    username?: string
    /** Gateway domain for user-facing worker URLs, e.g. "apps.teenybase.work" */
    gatewayDomain?: string
}

function getCredentialsPath(): string {
    return process.env.TEENYBASE_CREDENTIALS || path.join(os.homedir(), '.teenybase', 'credentials.json')
}

export function loadCredentials(): Credentials | null {
    const credPath = getCredentialsPath()
    if (!fs.existsSync(credPath)) return null
    try {
        const data = JSON.parse(fs.readFileSync(credPath, 'utf8'))
        if (!data.serverUrl || !data.email || !data.apiToken) return null
        return data as Credentials
    } catch {
        return null
    }
}

export function saveCredentials(creds: Credentials): void {
    const credPath = getCredentialsPath()
    fs.mkdirSync(path.dirname(credPath), {recursive: true})
    fs.writeFileSync(credPath, JSON.stringify(creds, null, 2) + '\n', {mode: 0o600})
}

export function deleteCredentials(): boolean {
    const credPath = getCredentialsPath()
    if (!fs.existsSync(credPath)) return false
    fs.unlinkSync(credPath)
    return true
}

/**
 * If Teenybase credentials exist and CLOUDFLARE_API_BASE_URL is not already set,
 * configure environment variables to route wrangler API calls through Teenybase.
 * Only activates for tb- prefixed account IDs.
 * Auto-refreshes expired platform JWTs using the saved refresh token.
 */
/** Decode a JWT payload without verification (for reading claims like `exp`, `verified`). */
export function decodeJwtPayload(token: string): Record<string, any> {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())
}

/**
 * Check if the JWT's email is verified. If not, prompt interactively or throw.
 * Returns the (possibly refreshed) token.
 */
export async function ensureEmailVerified(token: string, creds: Credentials, serverUrl: string, logger: Logger): Promise<string> {
    try {
        const payload = decodeJwtPayload(token)
        if (!payload.verified) {
            if (process.stdin.isTTY && creds.refreshToken) {
                const result = await waitForEmailVerification(
                    serverUrl, token, creds.refreshToken, creds.email,
                    (m) => logger.info(m),
                    (m) => logger.warn(m),
                )
                if (result) {
                    saveCredentials({...creds, serverUrl, apiToken: result.token, refreshToken: result.refreshToken})
                    return result.token
                }
                throw new Error('Email not verified. Verify your email and try again, or run `teeny login`.')
            }
            throw new Error(
                'Email not verified. Check your inbox for the verification link, then try again.\n' +
                'If you need a new verification email, run `teeny login`.'
            )
        }
    } catch (e) {
        if (e instanceof Error && e.message.includes('not verified')) throw e
        // JWT decode failed — skip check, let it fail at the proxy
    }
    return token
}

export async function applyManagedMode(accountId: string, logger: Logger): Promise<Credentials | null> {
    if (process.env.CLOUDFLARE_API_BASE_URL) return null
    if (!accountId || !accountId.startsWith('tb-')) return null
    const creds = loadCredentials()
    if (!creds) return null

    // Validate that the logged-in user owns the account_id in the wrangler config.
    // Without this check, a user could accidentally deploy to another user's account
    // if they cloned a project with a different tb-{userId} in the config.
    if (creds.userId) {
        const expectedAccountId = `tb-${creds.userId}`
        if (accountId !== expectedAccountId) {
            throw new CredentialMismatchError(
                `Credential mismatch: wrangler config has account_id "${accountId}" but you are logged in as "${expectedAccountId}" (${creds.email}).\n` +
                `Either log in as the correct user (\`teeny login\`), or update account_id in your wrangler config.`
            )
        }
    }

    const serverUrl = creds.serverUrl

    // Warn if server URL points to localhost (likely leftover from testing)
    try {
        const url = new URL(serverUrl)
        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
            logger.warn(`Teenybase server URL is ${serverUrl} (localhost). Run \`teeny login\` to switch to production.`)
        }
    } catch { /* invalid URL, will fail later */ }

    // Auto-refresh expired JWT
    let token = creds.apiToken
    try {
        const payload = decodeJwtPayload(token)
        const expiresAt = (payload.exp || 0) * 1000
        const buffer = 5 * 60 * 1000 // refresh 5 min before expiry
        if (Date.now() > expiresAt - buffer) {
            if (!creds.refreshToken) {
                logger.warn('Session expired. Run `teeny login` to re-authenticate.')
                return null
            }
            const res = await safeFetch(`${serverUrl}/api/v1/table/platform_users/auth/refresh-token`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({refresh_token: creds.refreshToken}),
                signal: AbortSignal.timeout(10000),
            })
            if (res.ok) {
                const data = await res.json() as any
                if (data.token && data.refresh_token) {
                    token = data.token
                    saveCredentials({...creds, serverUrl, apiToken: token, refreshToken: data.refresh_token})
                } else {
                    logger.warn('Token refresh returned unexpected response. Run `teeny login` to re-authenticate.')
                    return null
                }
            } else {
                logger.warn('Session expired. Run `teeny login` to re-authenticate.')
                return null
            }
        }
    } catch {
        // JWT decode failed or refresh failed — use existing token, let it fail at the proxy
    }

    token = await ensureEmailVerified(token, creds, serverUrl, logger)

    process.env.TEENYBASE_SERVER_URL = serverUrl
    process.env.CLOUDFLARE_API_BASE_URL = serverUrl + '/client/v4'
    logger.debug(`CLOUDFLARE_API_BASE_URL = ${process.env.CLOUDFLARE_API_BASE_URL}`)
    process.env.CLOUDFLARE_API_TOKEN = token
    return {...creds, serverUrl, apiToken: token}
}

/**
 * Interactive prompt loop that waits for the user to verify their email.
 * Checks verification by refreshing the platform JWT and reading the `verified` claim.
 * Returns updated token + refreshToken on success.
 */
export async function waitForEmailVerification(
    serverUrl: string,
    token: string,
    refreshToken: string,
    email: string,
    log: (msg: string) => void,
    warn: (msg: string) => void,
): Promise<{token: string, refreshToken: string} | null> {
    const prompts = (await import('prompts')).default
    log(`Verification email sent to ${email}. Check your inbox (and spam folder).`)

    for (let attempt = 0; attempt < 10; attempt++) {
        const res = await prompts({
            type: 'text',
            name: 'action',
            message: 'Press Enter to check, R to resend verification email, Ctrl+C to cancel',
        })

        if (res.action === undefined) return null // Ctrl+C

        const action = (res.action || '').trim().toLowerCase()

        if (action === 'r') {
            // Resend verification email
            try {
                const resendRes = await safeFetch(`${serverUrl}/api/v1/table/platform_users/auth/request-verification`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    },
                    signal: AbortSignal.timeout(10000),
                })
                if (resendRes.ok) {
                    log(`Verification email resent to ${email}.`)
                } else {
                    const data = await resendRes.json().catch(() => null) as any
                    warn(data?.message || 'Failed to resend verification email.')
                }
            } catch {
                warn('Failed to resend verification email. Check your connection.')
            }
            continue
        }

        // Check verification by refreshing token
        try {
            const refreshRes = await safeFetch(`${serverUrl}/api/v1/table/platform_users/auth/refresh-token`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({refresh_token: refreshToken}),
                signal: AbortSignal.timeout(10000),
            })
            if (refreshRes.ok) {
                const data = await refreshRes.json() as any
                if (data.token) {
                    token = data.token
                    refreshToken = data.refresh_token || refreshToken
                    // Check verified claim from new JWT
                    try {
                        const payload = decodeJwtPayload(token)
                        if (payload.verified) {
                            log('Email verified!')
                            return {token, refreshToken}
                        }
                    } catch { /* decode failed, continue */ }
                }
            }
        } catch { /* refresh failed, continue */ }

        warn('Email not verified yet. Check your inbox and spam folder.')
    }

    warn('Max retries reached. Please verify your email, then run `teeny login`.')
    return null
}


/**
 * Fetch with user-friendly error messages for network/timeout failures.
 * Wraps native fetch so callers don't see raw "fetch failed" errors.
 */
export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
    try {
        return await fetch(url, init)
    } catch (e: any) {
        if (e?.name === 'TimeoutError') throw new Error(`Request timed out (${url})`)
        throw new Error(`Could not connect to ${url}: ${e?.cause?.message || e?.message || e}`)
    }
}

/**
 * Fetch a JSON response from a managed platform API endpoint.
 * Reads serverUrl and apiToken from env vars set by applyManagedMode / loadValidatedCredentials.
 */
export async function managedFetch<T = any>(
    path: string,
    init?: RequestInit,
): Promise<T> {
    const serverUrl = process.env.TEENYBASE_SERVER_URL
    const apiToken = process.env.CLOUDFLARE_API_TOKEN
    if (!serverUrl || !apiToken) throw new Error('Managed mode not initialized. This is a bug — applyManagedMode or loadValidatedCredentials should have been called first.')
    const url = `${serverUrl}${path}`
    const res = await safeFetch(url, {
        ...init,
        headers: {
            'Authorization': `Bearer ${apiToken}`,
            ...init?.headers,
        },
    })
    let data: any
    try {
        data = await res.json()
    } catch {
        throw new Error(`Server returned invalid response (${res.status})`)
    }
    if (!res.ok) {
        throw new Error(data?.errors?.[0]?.message || `API error (${res.status})`)
    }
    return data as T
}

/**
 * Shared auth flow: call a teenybase auth endpoint (sign-up or login).
 * Returns the platform JWT + refresh token directly — no bridge needed.
 * The platform JWT is used as the CLOUDFLARE_API_TOKEN in managed mode.
 */
export async function authenticateAndGetToken(
    serverUrl: string,
    authPath: string,
    body: Record<string, string>,
): Promise<{ email: string; apiToken: string; refreshToken: string; gatewayDomain?: string; username?: string; userId?: string }> {
    // Call auth endpoint (sign-up or login)
    const authRes = await safeFetch(`${serverUrl}${authPath}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
    })
    let authData: any
    try {
        authData = await authRes.json()
    } catch {
        throw new Error(`Server returned invalid response (${authRes.status})`)
    }
    if (!authRes.ok) {
        let msg = authData?.error || authData?.message || `Auth failed (${authRes.status})`
        // Append field-level validation details if present (Zod error format)
        if (authData?.data && typeof authData.data === 'object' && !Array.isArray(authData.data)) {
            const fieldErrors: string[] = []
            for (const [field, val] of Object.entries(authData.data)) {
                const errs = (val as any)?._errors
                if (Array.isArray(errs) && errs.length) fieldErrors.push(`${field}: ${errs.join(', ')}`)
            }
            if (fieldErrors.length) msg += '\n  ' + fieldErrors.join('\n  ')
        }
        throw new Error(msg)
    }

    // Extract JWT from response — teenybase auth returns it in the `token` field
    const apiToken = authData?.token || authData?.data?.token
    if (!apiToken) {
        throw new Error('No token received from auth endpoint')
    }

    const refreshToken = authData?.refresh_token
    if (!refreshToken) {
        throw new Error('No refresh token received from auth endpoint')
    }

    // Fetch gateway domain (public endpoint, no auth needed)
    let gatewayDomain: string | undefined
    try {
        const infoRes = await safeFetch(`${serverUrl}/auth/gateway-info`, {signal: AbortSignal.timeout(5000)})
        if (infoRes.ok) {
            const infoData = await infoRes.json() as any
            gatewayDomain = infoData?.gateway_domain
        }
    } catch { /* non-critical */ }

    const username = authData?.record?.username
    const userId = authData?.record?.id
    return {email: body.email, apiToken, refreshToken, gatewayDomain, username, userId}
}

/** Shared auth flow for register and login. Authenticates, saves credentials, prompts for email verification. */
export async function authFlow(opts: {
    serverUrl: string,
    authPath: string,
    authBody: Record<string, string>,
    username?: string,
    actionLabel: string,
    interactive: boolean,
    logger: Logger,
}) {
    const {serverUrl, authPath, authBody, actionLabel, interactive, logger} = opts
    const {email, apiToken, refreshToken, gatewayDomain, username, userId} = await authenticateAndGetToken(serverUrl, authPath, authBody)
    const baseCreds: Credentials = {serverUrl, email, apiToken, refreshToken, gatewayDomain, username: opts.username || username, userId}
    saveCredentials(baseCreds)
    logger.info(colors.green(`${actionLabel} ${email}`))

    // Check email verification — decode JWT in its own try/catch so verification errors propagate
    let needsVerification = false
    try { needsVerification = !decodeJwtPayload(apiToken).verified } catch { /* JWT decode failed, skip */ }
    if (needsVerification) {
        if (interactive) {
            const verified = await waitForEmailVerification(
                serverUrl, apiToken, refreshToken, email,
                (m) => logger.info(colors.green(m)),
                (m) => logger.warn(colors.yellow(m)),
            )
            if (verified) {
                saveCredentials({...baseCreds, apiToken: verified.token, refreshToken: verified.refreshToken})
            }
        } else {
            logger.info(colors.yellow(`Verify your email before deploying. Check your inbox at ${email}.`))
        }
    }
}
