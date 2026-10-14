import colors from 'picocolors'
import {randomUUID} from 'node:crypto'
import {CliContext} from './cli-utils'
import {getAuthFromEnv, ApiCredentials} from './wrangler/users/users'
import {getCloudflareAccountIdFromEnv} from './wrangler/users/auth-variables'
import {safeFetch, managedFetch, NOT_LOGGED_IN_ERROR} from './credentials'
import {getErrorMessage} from './utils'

export interface LogsOptions {
    json?: boolean
    since?: string
    interval?: string | number
    overlap?: string | number
    limit?: string | number
    server?: string
}

/**
 * A function that executes a telemetry query for a given time window.
 * Returns the raw fetch Response (caller handles JSON parsing, errors, etc.)
 */
type QueryFn = (from: number, to: number) => Promise<Response>

/**
 * Stream logs from a deployed Cloudflare Worker via the telemetry query API.
 */
export async function runLogs(
    c: CliContext,
    name: string | undefined,
    options: LogsOptions,
): Promise<void> {
    const logger = c.logger

    const scriptName = name || c.wranglerConfig?.config?.config?.name
    if (!scriptName) {
        logger.error(colors.red('Worker name required. Provide as argument or run from a project with wrangler.jsonc.'))
        process.exit(1)
    }

    const accountId = c.wranglerConfig?.config?.config?.account_id || getCloudflareAccountIdFromEnv()
    if (!accountId) {
        logger.error(colors.red('account_id not found in wrangler config. Set it in wrangler.jsonc or set CLOUDFLARE_ACCOUNT_ID.'))
        process.exit(1)
    }

    const interval = parseDuration(options.interval?.toString() || '8s')
    const overlap = parseDuration(options.overlap?.toString() || '1m')
    const sinceMs = parseDuration(options.since || '5m')
    const limit = options.limit ? Number(options.limit) : 0

    let queryFn: QueryFn

    if (accountId.startsWith('tb-')) {
        // Managed mode — proxy through platform backend
        // todo: token expires after 1hr with no auto-refresh; CLI exits and user must re-run
        const result = await setupManagedMode(scriptName, logger)
        queryFn = result.queryFn
    } else {
        // Self-hosted — hit CF API directly
        const result = setupSelfHostedMode(accountId, scriptName, logger)
        queryFn = result.queryFn
    }

    logger.info(colors.dim(`Streaming logs for ${colors.bold(scriptName)}... (Ctrl+C to stop)`))
    logger.info(colors.dim(`  Note: logs may appear with ~1-2 min delay (Cloudflare ingestion)\n`))

    await pollLoop({queryFn, sinceMs, interval, overlap, json: options.json ?? false, limit})
}

// ── Mode setup ────────────────────────────────────────────────

function setupSelfHostedMode(
    accountId: string,
    scriptName: string,
    logger: any,
): {queryFn: QueryFn} {
    const creds = getAuthFromEnv()
    if (!creds) {
        logger.error(colors.red(
            'No Cloudflare credentials found. Set CLOUDFLARE_API_TOKEN environment variable.\n' +
            'Create an API token at https://dash.cloudflare.com/profile/api-tokens with \'Workers:Read\' permission.'
        ))
        process.exit(1)
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`
    const headers: Record<string, string> = {'Content-Type': 'application/json'}
    if ('apiToken' in creds) {
        headers['Authorization'] = `Bearer ${creds.apiToken}`
    } else {
        headers['X-Auth-Key'] = creds.authKey
        headers['X-Auth-Email'] = creds.authEmail
    }

    const bodyTemplate = makeBodyTemplate(scriptName)

    const queryFn: QueryFn = async (from, to) => {
        bodyTemplate.queryId = randomUUID()
        bodyTemplate.timeframe.from = from
        bodyTemplate.timeframe.to = to
        return safeFetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(bodyTemplate),
            signal: AbortSignal.timeout(15000),
        })
    }

    return {queryFn}
}

async function setupManagedMode(
    workerName: string,
    logger: any,
): Promise<{queryFn: QueryFn}> {
    const serverUrl = process.env.TEENYBASE_SERVER_URL
    const apiToken = process.env.CLOUDFLARE_API_TOKEN
    if (!serverUrl || !apiToken) throw new Error(NOT_LOGGED_IN_ERROR)

    // Get a temp logs token from the platform backend
    logger.info(colors.dim('  Requesting logs access...'))
    let logsToken: string
    let cfScriptName: string
    try {
        const data = await managedFetch('/client/v4/managed/logs/token', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({workerName}),
            signal: AbortSignal.timeout(15000),
        })
        logsToken = data.result.token
        cfScriptName = data.result.scriptName
    } catch (e: any) {
        logger.error(colors.red(`Failed to get logs access: ${getErrorMessage(e)}`))
        process.exit(1)
    }

    const queryUrl = `${serverUrl}/client/v4/managed/logs/query`
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`,
        'X-Logs-Token': logsToken,
    }
    const bodyTemplate = makeBodyTemplate(cfScriptName)

    const queryFn: QueryFn = async (from, to) => {
        bodyTemplate.queryId = randomUUID()
        bodyTemplate.timeframe.from = from
        bodyTemplate.timeframe.to = to
        return safeFetch(queryUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(bodyTemplate),
            signal: AbortSignal.timeout(15000),
        })
    }

    return {queryFn}
}

function makeBodyTemplate(scriptName: string) {
    return {
        queryId: '',
        timeframe: {from: 0, to: 0},
        view: 'events' as const,
        limit: 100,
        parameters: {
            datasets: [] as string[],
            filters: [
                {key: '$workers.scriptName', operation: 'eq', type: 'string', value: scriptName},
            ],
            filterCombination: 'and' as const,
        },
    }
}

// ── Polling loop ──────────────────────────────────────────────

interface PollConfig {
    queryFn: QueryFn
    sinceMs: number
    interval: number
    overlap: number
    json: boolean
    limit: number
}

const SEEN_IDS_MAX = 10000
const SEEN_IDS_PRUNE = 5000

async function pollLoop(config: PollConfig): Promise<void> {
    const {queryFn, sinceMs, interval, overlap, json, limit} = config
    const seenIds = new Set<string>()
    let from = Date.now() - sinceMs
    let running = true
    let firstPollDone = false
    let printed = 0
    let sleepResolve: (() => void) | undefined

    const cleanup = () => {
        running = false
        sleepResolve?.()
    }
    process.on('SIGINT', cleanup)
    process.on('SIGTERM', cleanup)

    try {
        while (running) {
            const to = Date.now()

            try {
                const res = await queryFn(from, to)

                if (!res.ok) {
                    const status = res.status
                    await res.text().catch(() => {}) // drain body
                    if (status === 401 || status === 403) {
                        process.stderr.write(colors.red('\nSession expired or authentication failed. Run `teeny logs` again.\n'))
                        process.exit(1)
                    }
                    const err: any = new Error(`API error: ${status} ${res.statusText}`)
                    err.status = status
                    throw err
                }

                const data = await res.json() as any
                if (!firstPollDone) {
                    firstPollDone = true
                    const count = data?.result?.events?.count ?? 0
                    if (count === 0) {
                        process.stderr.write(colors.dim('  Connected. Waiting for logs...\n'))
                    }
                }
                const events: any[] = data?.result?.events?.events ?? []

                // Deduplicate
                const newEvents: any[] = []
                for (const event of events) {
                    const id = event.$metadata?.id
                    if (id && seenIds.has(id)) continue
                    if (id) seenIds.add(id)
                    newEvents.push(event)
                }

                if (json) {
                    // JSON mode: output each new event as-is, sorted by timestamp
                    newEvents.sort((a: any, b: any) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
                    for (const event of newEvents) {
                        process.stdout.write(JSON.stringify(event) + '\n')
                        printed++
                        if (limit > 0 && printed >= limit) { running = false; break }
                    }
                } else {
                    // Group events by requestId, format as blocks
                    const output = formatEventBatch(newEvents)
                    for (const line of output) {
                        process.stdout.write(line + '\n')
                        printed++
                        if (limit > 0 && printed >= limit) { running = false; break }
                    }
                }

                // Prune seen IDs if too large — iterate instead of allocating an array
                if (seenIds.size > SEEN_IDS_MAX) {
                    let count = 0
                    for (const id of seenIds) {
                        if (count >= SEEN_IDS_PRUNE) break
                        seenIds.delete(id)
                        count++
                    }
                }

                // Only advance window on success — on failure, retry the same window
                from = to - overlap
            } catch (e: any) {
                if (e?.status === 401 || e?.status === 403) {
                    process.stderr.write(colors.red('\nSession expired or authentication failed. Run `teeny logs` again.\n'))
                    process.exit(1)
                }
                // Network or transient errors — warn and continue
                process.stderr.write(colors.yellow(`  Warning: ${getErrorMessage(e)}, retrying...\n`))
            }

            if (running) {
                await new Promise<void>((resolve) => {
                    sleepResolve = resolve
                    setTimeout(resolve, interval)
                })
                sleepResolve = undefined
            }
        }
    } finally {
        process.off('SIGINT', cleanup)
        process.off('SIGTERM', cleanup)
    }

    process.stderr.write(colors.dim('\nStopped.\n'))
}

// ── Event formatting ──────────────────────────────────────────
//
// CF telemetry returns multiple events per request, linked by $workers.requestId:
//   1. $metadata.type === "cf-worker-event" — main invocation (cpuTime, response, full request details)
//   2. $metadata.type === "cf-worker" — console.log/info/warn/error output and Hono logger lines
//
// We group by requestId and show: invocation line first, then console logs indented below.
// Events without a requestId (orphans) are shown standalone.

function formatEventBatch(events: any[]): string[] {
    // Group by requestId
    const groups = new Map<string, any[]>()
    const orphans: any[] = []

    for (const event of events) {
        const reqId = event.$workers?.requestId
        if (reqId) {
            let group = groups.get(reqId)
            if (!group) { group = []; groups.set(reqId, group) }
            group.push(event)
        } else {
            orphans.push(event)
        }
    }

    // Sort groups by earliest timestamp
    const sortedGroups = [...groups.values()].sort((a, b) => {
        const tsA = Math.min(...a.map((e: any) => e.timestamp ?? Infinity))
        const tsB = Math.min(...b.map((e: any) => e.timestamp ?? Infinity))
        return tsA - tsB
    })

    const output: string[] = []

    for (const group of sortedGroups) {
        output.push(...formatGroup(group))
    }

    // Orphan events at the end
    for (const event of orphans) {
        const line = formatStandaloneEvent(event)
        if (line) output.push(line)
    }

    return output
}

function formatGroup(events: any[]): string[] {
    const lines: string[] = []

    // Find the invocation event (cf-worker-event)
    const invocation = events.find(e => e.$metadata?.type === 'cf-worker-event')
    // Console log events: cf-worker type with source that has level/message (not request/response from Hono)
    const consoleLogs = events.filter(e => {
        if (e === invocation) return false
        const source = e.source ?? {}
        // Skip Hono logger request/response events (redundant with invocation)
        if (source.type === 'request' || source.type === 'response') return false
        return true
    })

    // Invocation line first
    if (invocation) {
        lines.push(formatInvocationLine(invocation))
    }

    // Console logs below, in timestamp + ID order (CF returns them in reverse sometimes)
    consoleLogs.sort((a: any, b: any) => {
        const tsDiff = (a.timestamp ?? 0) - (b.timestamp ?? 0)
        if (tsDiff !== 0) return tsDiff
        // Same timestamp: use ID (ULID-like, lexicographic order = chronological)
        return (a.$metadata?.id ?? '').localeCompare(b.$metadata?.id ?? '')
    })

    for (const event of consoleLogs) {
        const line = formatConsoleLog(event)
        if (line) lines.push(line)
    }

    return lines
}

function formatInvocationLine(event: any): string {
    const workers = event.$workers ?? {}
    const meta = event.$metadata ?? {}
    const outcome = workers.outcome ?? meta.outcome ?? 'unknown'
    const ts = formatTimestamp(event.timestamp)

    const eventType = workers.eventType ?? 'fetch'
    if (eventType === 'fetch') {
        const req = workers.event?.request
        const method = req?.method ?? 'GET'
        const path = req?.path ?? ''
        const search = req?.search ? '?' + new URLSearchParams(req.search).toString() : ''
        const status = workers.event?.response?.status
        const statusStr = status ? ` ${colorStatus(status)}` : ''
        const cpuStr = workers.cpuTimeMs != null ? colors.dim(` (${workers.cpuTimeMs}ms)`) : ''
        return `${colors.cyan(method)} ${path}${search}${statusStr} - ${colorOutcome(outcome)}${cpuStr} ${colors.dim('@ ' + ts)}`
    } else if (eventType === 'scheduled' || eventType === 'cron') {
        const cron = workers.event?.cron ?? eventType
        return `${colors.cyan(`"${cron}"`)} - ${colorOutcome(outcome)} ${colors.dim('@ ' + ts)}`
    }
    return `${colors.cyan(eventType)} - ${colorOutcome(outcome)} ${colors.dim('@ ' + ts)}`
}

function formatConsoleLog(event: any): string | null {
    const source = event.source ?? {}
    const meta = event.$metadata ?? {}
    const level = source.level || meta.level || 'log'
    const message = source.message || meta.message
    if (!message) return null

    let text = typeof message === 'string' ? message : JSON.stringify(message)

    // CF stringifies console.info({...}) and includes the `level` field — try to strip it for cleaner output
    if (text.startsWith('{') && text.includes('"level"')) {
        try {
            const parsed = JSON.parse(text)
            if (parsed.level) {
                const {level: _, ...rest} = parsed
                text = JSON.stringify(rest)
            }
        } catch { /* not JSON, use as-is */ }
    }

    return `  ${colorLevel(level)} ${text}`
}

function formatStandaloneEvent(event: any): string | null {
    const source = event.source ?? {}
    const meta = event.$metadata ?? {}
    const ts = formatTimestamp(event.timestamp)

    if (source.type === 'request' || source.type === 'response') return null

    const message = source.message || meta.message
    if (!message) return null

    const level = source.level || meta.level || 'log'
    return `${colorLevel(level)} ${message} ${colors.dim('@ ' + ts)}`
}

function formatTimestamp(ts: number | undefined): string {
    if (!ts) return ''
    return new Date(ts).toLocaleTimeString()
}

function colorOutcome(outcome: string): string {
    const normalized = outcome.toLowerCase()
    if (normalized === 'ok') return colors.green('Ok')
    if (normalized === 'exception' || normalized.includes('exceeded')) return colors.red(outcome)
    if (normalized === 'canceled') return colors.yellow('Canceled')
    return outcome
}

function colorStatus(status: number): string {
    if (status >= 500) return colors.red(String(status))
    if (status >= 400) return colors.yellow(String(status))
    if (status >= 300) return colors.yellow(String(status))
    return colors.green(String(status))
}

function colorLevel(level: string): string {
    switch (level) {
        case 'error': return colors.red(`(${level})`)
        case 'warn': return colors.yellow(`(${level})`)
        case 'debug': return colors.dim(`(${level})`)
        default: return colors.dim(`(${level})`)
    }
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Parse duration strings like "30s", "5m", "1h", "2d" into milliseconds.
 */
export function parseDuration(str: string): number {
    const match = str.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i)
    if (!match) throw new Error(`Invalid duration: "${str}". Use format like 30s, 5m, 1h, 2d.`)
    const value = parseFloat(match[1])
    const unit = match[2].toLowerCase()
    if (unit === 's') return value * 1000
    if (unit === 'm') return value * 60_000
    if (unit === 'h') return value * 3_600_000
    // unit === 'd'
    return value * 86_400_000
}
