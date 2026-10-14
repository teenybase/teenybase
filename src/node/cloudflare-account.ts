import {ask} from './prompts'
import {readableRelative} from './utils'
import {applyManagedMode} from './credentials'
import {CliContext, writeAccountIdToWranglerConfig} from './cli-utils'
import {resolveWranglerPackage} from './utils/wrangler-bin'
import {
    NOT_LOGGED_IN_HINT,
    stripAnsi,
    versionAtLeast,
    withMinimalWranglerConfig,
    WRANGLER_MIN_WHOAMI_JSON,
    WranglerCommandError,
} from './utils/wrangler-run'

export interface WhoamiAccount {
    id: string
    name: string
}

/**
 * Parse `wrangler whoami --json` stdout: `{"loggedIn": true, "accounts": [{id, name}], ...}` or,
 * with a non-zero exit, `{"loggedIn": false}`. Undefined if there's no JSON object.
 */
export function parseWhoamiJson(stdout: string): {loggedIn: boolean, email?: string, accounts: WhoamiAccount[]} | undefined {
    const text = stripAnsi(stdout)
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end < start) return undefined
    let data: any
    try {
        data = JSON.parse(text.slice(start, end + 1))
    } catch {
        return undefined
    }
    if (typeof data?.loggedIn !== 'boolean') return undefined
    const accounts = Array.isArray(data.accounts)
        ? data.accounts.filter((a: any) => a && typeof a.id === 'string').map((a: any) => ({id: a.id, name: String(a.name ?? a.id)}))
        : []
    return {loggedIn: data.loggedIn, email: typeof data.email === 'string' ? data.email : undefined, accounts}
}

/** The Cloudflare accounts of the current wrangler login (`wrangler whoami --json`). */
export async function listLoginAccounts(c: CliContext): Promise<WhoamiAccount[]> {
    const {version} = resolveWranglerPackage(c.root)
    if (!versionAtLeast(version, WRANGLER_MIN_WHOAMI_JSON)) {
        throw new Error(`account_id is not set. Set account_id in ${readableRelative(c.wranglerConfig.config.path)} or the CLOUDFLARE_ACCOUNT_ID environment variable, or update wrangler to ${WRANGLER_MIN_WHOAMI_JSON} or newer ("npm install --save-dev wrangler@latest") so teeny can read it from your login.`)
    }
    let stdout: string
    try {
        stdout = (await withMinimalWranglerConfig(c.wranglerConfig.config.config, configPath =>
            c.runWrangler(['whoami', '--json', `--config=${configPath}`], {echo: false}))).stdout
    } catch (e) {
        if (e instanceof WranglerCommandError) {
            const parsed = parseWhoamiJson(e.stdout)
            if (parsed && !parsed.loggedIn) throw new Error(NOT_LOGGED_IN_HINT)
            throw new Error(`Couldn't read your Cloudflare login with "wrangler whoami": ${e.message}`)
        }
        throw e
    }
    const parsed = parseWhoamiJson(stdout)
    if (!parsed) throw new Error(`Unexpected output from "wrangler whoami --json": ${stdout.slice(0, 300)}`)
    if (!parsed.loggedIn) throw new Error(NOT_LOGGED_IN_HINT)
    return parsed.accounts
}

/**
 * The Cloudflare account `teeny deploy --remote` deploys to (own-account path; `--temporary` uses
 * prepareTemporaryAccount instead):
 * 1. `account_id` in the wrangler config, else the CLOUDFLARE_ACCOUNT_ID env variable;
 * 2. else, interactively and only when a Teenybase Cloud login exists, ask Teenybase Cloud or own account;
 * 3. else the account of the wrangler login (`npx wrangler login` or CLOUDFLARE_API_TOKEN): used
 *    directly when there is one, chosen interactively when there are several (with --yes: an error
 *    that lists them). The id is then saved as account_id in the wrangler config.
 * A deploy target is never picked on the user's behalf beyond (3).
 */
export async function resolveDeployAccountId(c: CliContext, skipConfirmation: boolean): Promise<string> {
    const configFile = readableRelative(c.wranglerConfig.config.path)
    const configured = c.wranglerConfig.config.config.account_id
    let accountId = (typeof configured === 'string' ? configured.trim() : '') || (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim()

    if (accountId) {
        if (accountId.startsWith('tb-') && !process.env.CLOUDFLARE_API_BASE_URL) {
            // applyManagedMode ran in initContext but found no credentials
            throw new Error(`account_id "${accountId}" requires Teenybase credentials. Run \`teeny login\` first.`)
        }
        return accountId
    }

    if (!skipConfirmation && c.credentials) {
        const target = await ask<string>({
            type: 'select',
            message: 'Where do you want to deploy?',
            choices: [
                {title: 'Teenybase Cloud', value: 'managed'},
                {title: 'Your own Cloudflare account', value: 'self-hosted'},
            ],
        }, `Set account_id in ${configFile} or the CLOUDFLARE_ACCOUNT_ID environment variable.`)
        if (target === 'managed') {
            const creds = c.credentials
            if (!creds.userId) throw new Error('Credentials missing userId. Run `teeny login` again.')
            accountId = `tb-${creds.userId}`
            writeAccountIdToWranglerConfig(c.wranglerConfig.config.path, accountId)
            c.logger.info(`Set account_id = "${accountId}" in ${configFile}.`)
            const refreshed = await applyManagedMode(accountId, c.logger)
            if (refreshed) c.setCredentials(refreshed)
            return accountId
        }
        if (target !== 'self-hosted') throw new Error('Cancelled')
    }

    const accounts = await listLoginAccounts(c)
    let account: WhoamiAccount | undefined
    if (accounts.length === 1) {
        account = accounts[0]
    } else if (accounts.length === 0) {
        throw new Error(`Your Cloudflare login has no accounts teeny can see (an API token needs the "Account Settings: Read" permission to list them). Set account_id in ${configFile} or the CLOUDFLARE_ACCOUNT_ID environment variable.`)
    } else if (skipConfirmation) {
        throw new Error(`Your Cloudflare login has ${accounts.length} accounts. Choose one by setting account_id in ${configFile} or the CLOUDFLARE_ACCOUNT_ID environment variable:\n${accounts.map(a => `  ${a.name}: ${a.id}`).join('\n')}`)
    } else {
        const id = await ask<string>({
            type: 'select',
            message: 'Which Cloudflare account do you want to deploy to?',
            choices: accounts.map(a => ({title: `${a.name} (${a.id})`, value: a.id})),
        }, `Set account_id in ${configFile} or the CLOUDFLARE_ACCOUNT_ID environment variable.`)
        account = accounts.find(a => a.id === id)
        if (!account) throw new Error('Cancelled')
    }
    writeAccountIdToWranglerConfig(c.wranglerConfig.config.path, account.id)
    c.logger.info(`Deploying to Cloudflare account "${account.name}" (${account.id}) from your wrangler login. Saved it as account_id in ${configFile}.`)
    return account.id
}
