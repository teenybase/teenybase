import {spawn} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type {Logger} from '../logger'
import {resolveWranglerPackage} from './wrangler-bin'

/** `--temporary` (deploy without a Cloudflare login) needs this wrangler or newer. */
export const WRANGLER_MIN_TEMPORARY = '4.102.0'
/** `wrangler deploy --secrets-file` (secrets uploaded with the deployment) needs this wrangler or newer. */
export const WRANGLER_MIN_SECRETS_FILE = '4.74.0'
/** `wrangler whoami --json` needs this wrangler or newer. */
export const WRANGLER_MIN_WHOAMI_JSON = '4.65.0'

/**
 * Compare two dotted versions numerically (`4.102.0` > `4.99.1`). Anything after `-` or `+`
 * (prerelease/build tags) is ignored; missing parts count as 0. Returns <0, 0 or >0.
 */
export function compareVersions(a: string, b: string): number {
    const parts = (v: string) => v.trim().split(/[-+]/)[0].split('.').map(p => parseInt(p, 10) || 0)
    const pa = parts(a), pb = parts(b)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0)
        if (d !== 0) return d
    }
    return 0
}

export function versionAtLeast(version: string, min: string): boolean {
    return !!version && compareVersions(version, min) >= 0
}

/**
 * Top-level wrangler commands that accept `--temporary` (in wrangler 4.150 every subcommand of these
 * has `behaviour.supportTemporary: true`). `dev`, `types`, `whoami`, `login`/`logout` don't, and
 * `deploy --dry-run` never talks to Cloudflare.
 */
const TEMPORARY_COMMANDS = new Set([
    'deploy', 'delete', 'versions', 'deployments', 'triggers', 'tail', 'secret',
    'd1', 'kv', 'queues', 'hyperdrive', 'r2', 'containers', 'cert', 'turnstile',
])

/** Whether `wrangler <args>` talks to Cloudflare in a way that accepts `--temporary`. */
export function supportsTemporaryFlag(args: string[]): boolean {
    const command = args[0]
    if (!command || !TEMPORARY_COMMANDS.has(command)) return false
    return !args.includes('--dry-run')
}

/**
 * The argv to run for `wrangler <args>`. With `temporary`, `--temporary` is appended to every command
 * that supports it, so a call site can't forget it. Every wrangler spawn in the CLI goes through this.
 */
export function wranglerArgs(args: string[], temporary: boolean): string[] {
    if (!temporary || !supportsTemporaryFlag(args) || args.includes('--temporary')) return args
    return [...args, '--temporary']
}

/** `[command, argv]` that spawns wrangler with node and no shell (see `resolveWranglerBin`). */
export function wranglerCommand(root: string, args: string[], temporary: boolean): [string, string[]] {
    return [process.execPath, [resolveWranglerPackage(root).bin, ...wranglerArgs(args, temporary)]]
}

const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]/g
export function stripAnsi(text: string): string {
    return text.replace(ANSI_RE, '')
}

/** A new temporary account isn't usable for a few seconds: its API token is rejected with code 10000. */
export function isTemporaryAccountWarmupError(output: string): boolean {
    return /\[code: 10000\]/.test(stripAnsi(output))
}

/** Output of wrangler when it has no credentials (and suggests `--temporary` itself). */
export function isNotLoggedInOutput(output: string): boolean {
    const text = stripAnsi(output)
    return text.includes('rerun this command with `--temporary`')
        || text.includes('necessary to set a CLOUDFLARE_API_TOKEN environment variable')
        || text.includes('You are not authenticated. Please run `wrangler login`')
}

/** Wrangler's own error when `--temporary` is used while logged in (OAuth or env token). */
export function isAlreadyAuthenticatedOutput(output: string): boolean {
    return stripAnsi(output).includes("so `--temporary` can't be used")
}

export const NOT_LOGGED_IN_HINT = 'You are not logged in to Cloudflare. Run "npx wrangler login" (or set CLOUDFLARE_API_TOKEN), or deploy without an account: "npx teenybase deploy --temporary".'
export const ALREADY_AUTHENTICATED_HINT = 'You are logged in to Cloudflare, so --temporary can\'t be used: temporary accounts are only for deploying without a login. Deploy to your account with "npx teenybase deploy --remote", or run "npx wrangler logout" (and unset CLOUDFLARE_API_TOKEN) first.'

/**
 * Hides wrangler's "Temporary account ready:" block and its Terms of Service line from the live
 * output. Wrangler prints the block (with the claim URL) on every `--temporary` call; teeny prints
 * the account status once up front and the claim details once at the end instead.
 * The full text is still captured for parsing.
 */
export class TemporaryNoticeFilter {
    private partial = ''
    private inBlock = false

    push(chunk: string): string {
        const text = this.partial + chunk
        const lastNewline = text.lastIndexOf('\n')
        if (lastNewline < 0) {
            this.partial = text
            return ''
        }
        this.partial = text.slice(lastNewline + 1)
        return this.filterLines(text.slice(0, lastNewline + 1))
    }

    flush(): string {
        const rest = this.partial
        this.partial = ''
        return rest ? this.filterLines(rest) : ''
    }

    private filterLines(text: string): string {
        const lines = text.split(/(?<=\n)/)
        let out = ''
        for (const line of lines) {
            const plain = stripAnsi(line)
            if (this.inBlock) {
                if (/^\s+(Account|Claim within|Claim URL):/.test(plain)) continue
                this.inBlock = false
            }
            if (plain.startsWith('Temporary account ready:')) {
                this.inBlock = true
                continue
            }
            if (plain.startsWith('Continuing means you accept Cloudflare\'s Terms of Service')) continue
            out += line
        }
        return out
    }
}

export class WranglerCommandError extends Error {
    constructor(
        message: string,
        public readonly args: string[],
        public readonly status: number | null,
        public readonly stdout: string,
        public readonly stderr: string,
        public readonly output: string,
    ) {
        super(message)
        this.name = 'WranglerCommandError'
    }
}

export interface WranglerResult {
    stdout: string
    stderr: string
    /** stdout and stderr interleaved in arrival order */
    output: string
}

export interface RunWranglerOptions {
    root: string
    args: string[]
    logger: Logger
    /** Append `--temporary` where supported (see {@link wranglerArgs}) and retry the new-account code 10000 error. */
    temporary?: boolean
    /** Print wrangler's output while it runs (default true). Output is always captured. */
    echo?: boolean
    env?: NodeJS.ProcessEnv
    /** Waits between attempts when a temporary account isn't ready yet (code 10000). */
    retryDelaysMs?: number[]
}

/**
 * Up to ~40 s of retries. The T3 spike saw `d1 create` fail with code 10000 right after the
 * temporary account was created and succeed 35 s later on the same account.
 */
export const TEMPORARY_WARMUP_RETRY_DELAYS_MS = [3000, 5000, 8000, 10000, 15000]

let warmupAnnounced = false

/**
 * Run `wrangler <args>` (node + wrangler's JS entry, no shell) in `root`, capturing its output.
 * Rejects with a {@link WranglerCommandError} on a non-zero exit. stdin is not connected: teeny asks
 * its own questions, and wrangler treats the run as non-interactive.
 */
export async function runWrangler(opts: RunWranglerOptions): Promise<WranglerResult> {
    const delays = opts.retryDelaysMs ?? TEMPORARY_WARMUP_RETRY_DELAYS_MS
    for (let attempt = 0; ; attempt++) {
        try {
            return await spawnWrangler(opts)
        } catch (e) {
            const retry = opts.temporary
                && e instanceof WranglerCommandError
                && isTemporaryAccountWarmupError(e.output)
                && attempt < delays.length
            if (!retry) throw e
            const total = Math.round(delays.slice(attempt).reduce((a, b) => a + b, 0) / 1000)
            if (!warmupAnnounced) {
                opts.logger.info(`Cloudflare is still setting up the temporary account (code 10000); retrying for up to ${total} s...`)
                warmupAnnounced = true
            }
            opts.logger.debug(`wrangler ${opts.args.slice(0, 2).join(' ')}: code 10000, retry ${attempt + 1}/${delays.length} in ${delays[attempt]} ms`)
            await new Promise(r => setTimeout(r, delays[attempt]))
        }
    }
}

function spawnWrangler(opts: RunWranglerOptions): Promise<WranglerResult> {
    const echo = opts.echo ?? true
    const [cmd, argv] = wranglerCommand(opts.root, opts.args, !!opts.temporary)
    opts.logger.debug(`Running: wrangler ${argv.slice(1).map(a => a.length > 120 ? a.slice(0, 120) + '...' : a).join(' ')}`)
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, argv, {cwd: opts.root, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe']})
        let stdout = '', stderr = '', output = ''
        const outFilter = opts.temporary ? new TemporaryNoticeFilter() : undefined
        const errFilter = opts.temporary ? new TemporaryNoticeFilter() : undefined
        child.stdout.on('data', (data: Buffer) => {
            const chunk = data.toString()
            stdout += chunk
            output += chunk
            if (echo) process.stdout.write(outFilter ? outFilter.push(chunk) : chunk)
        })
        child.stderr.on('data', (data: Buffer) => {
            const chunk = data.toString()
            stderr += chunk
            output += chunk
            if (echo) process.stderr.write(errFilter ? errFilter.push(chunk) : chunk)
        })
        child.on('error', reject)
        child.on('close', (code) => {
            if (echo && outFilter && errFilter) {
                process.stdout.write(outFilter.flush())
                process.stderr.write(errFilter.flush())
            }
            if (code === 0) return resolve({stdout, stderr, output})
            // Error text gets printed and rethrown by callers: never let the claim URL ride along
            const out = redactClaimTokens(output)
            reject(new WranglerCommandError(describeFailure(opts.args, code, out), opts.args, code, redactClaimTokens(stdout), redactClaimTokens(stderr), out))
        })
    })
}

/**
 * The claim URL (`...claim-preview?claimToken=...`) is a bearer credential: anyone with it can take
 * the temporary account. Only teeny's end-of-deploy block and `.teeny/temporary.json` may show it.
 */
export function redactClaimTokens(text: string): string {
    return text.replace(/claimToken=[^\s"'&]+/g, 'claimToken=<redacted>')
}

function describeFailure(args: string[], code: number | null, output: string): string {
    const command = `wrangler ${args.filter(a => !a.startsWith('-')).slice(0, 2).join(' ')}`
    const text = stripAnsi(output)
    if (isAlreadyAuthenticatedOutput(text)) return ALREADY_AUTHENTICATED_HINT
    // "✘ [ERROR] <message>" lines, plus the API error notes wrangler prints under them ("Authentication error [code: 10000]")
    const errors = text.split('\n')
        .filter(l => /\[ERROR\]/.test(l) || /\[code: \d+\]/.test(l))
        .map(l => l.replace(/^.*?\[ERROR\]\s*/, '').trim())
        .filter((l, i, all) => l && all.indexOf(l) === i)
    let message = `${command} failed (exit code ${code ?? 'unknown'})${errors.length ? ': ' + errors.join(' ') : ''}`
    if (isNotLoggedInOutput(text)) message += `\n${NOT_LOGGED_IN_HINT}`
    return message
}

/**
 * Run `fn` with the path of a throwaway wrangler config that only has the worker `name` (and
 * `account_id` if set). For commands that don't need the project's bindings (`whoami`, `d1 list`,
 * `d1 create`): the real config can hold TEENY_AUTO_CREATE placeholders that wrangler rejects.
 */
export async function withMinimalWranglerConfig<T>(realConfig: any, fn: (configPath: string) => Promise<T>): Promise<T> {
    const tempConfigPath = path.join(os.tmpdir(), `teeny-wrangler-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`)
    const tempConfig: Record<string, any> = {name: realConfig?.name || 'teeny-temp'}
    if (realConfig?.account_id) tempConfig.account_id = realConfig.account_id
    fs.writeFileSync(tempConfigPath, JSON.stringify(tempConfig))
    try {
        return await fn(tempConfigPath)
    } finally {
        try { fs.unlinkSync(tempConfigPath) } catch { /* already gone */ }
    }
}
