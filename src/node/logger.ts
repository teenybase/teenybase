/* eslint no-console: 0 */

import readline from 'readline'
import colors from 'picocolors'
import type { RollupError } from 'rollup'

// Unicode symbols with ASCII fallbacks for non-TTY/piped output
const isTTY = process.stdout.isTTY && colors.isColorSupported
export const symbols = {
    success: isTTY ? '✔' : '+',
    error: isTTY ? '✘' : 'x',
    warning: isTTY ? '⚠' : '!',
    section: isTTY ? '◆' : '*',
}

export type LogType = 'error' | 'warn' | 'info' | 'debug'
export type LogLevel = LogType | 'silent'
export interface Logger {
    debug(msg: string, options?: LogOptions): void
    info(msg: string, options?: LogOptions): void
    warn(msg: string, options?: LogOptions): void
    warnOnce(msg: string, options?: LogOptions): void
    error(msg: string, options?: LogErrorOptions): void
    clearScreen(type: LogType): void
    hasErrorLogged(error: Error | RollupError): boolean
    hasWarned: boolean
    level: LogLevel
    // CLI output helpers (info-level, no-op when level < info)
    section?(title: string): void
    success?(msg: string): void
    done?(msg?: string): void
}

export interface LogOptions {
    clear?: boolean
    timestamp?: boolean
    environment?: string
}

export interface LogErrorOptions extends LogOptions {
    error?: Error | RollupError | null
}

export const LogLevels: Record<LogLevel, number> = {
    silent: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
}

let lastType: LogType | undefined
let lastMsg: string | undefined
let sameCount = 0

function clearScreen() {
    const repeatCount = process.stdout.rows - 2
    const blank = repeatCount > 0 ? '\n'.repeat(repeatCount) : ''
    console.log(blank)
    readline.cursorTo(process.stdout, 0, 0)
    readline.clearScreenDown(process.stdout)
}

export interface LoggerOptions {
    prefix?: string
    allowClearScreen?: boolean
    customLogger?: Logger
    console?: Console
}

// Only initialize the timeFormatter when the timestamp option is used, and
// reuse it across all loggers
let timeFormatter: Intl.DateTimeFormat
function getTimeFormatter() {
    timeFormatter ??= new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
    })
    return timeFormatter
}

export function createLogger(
    level: LogLevel = 'info',
    options: LoggerOptions = {},
): Logger {
    if (options.customLogger) {
        return options.customLogger
    }

    const loggedErrors = new WeakSet<Error | RollupError>()
    const {
        prefix = '[teeny]',
        allowClearScreen = true,
        console = (globalThis as any).console,
    } = options
    const thresh = LogLevels[level]
    const canClearScreen =
        allowClearScreen && process.stdout.isTTY && !process.env.CI
    const clear = canClearScreen ? clearScreen : () => {}

    function format(type: LogType, msg: string, options: LogErrorOptions = {}) {
        if (options.timestamp) {
            let tag = ''
            if (type === 'info') {
                tag = colors.cyan(colors.bold(prefix))
            } else if (type === 'warn') {
                tag = colors.yellow(colors.bold(prefix))
            } else {
                tag = colors.red(colors.bold(prefix))
            }
            const environment = options.environment ? options.environment + ' ' : ''
            return `${colors.dim(getTimeFormatter().format(new Date()))} ${tag} ${environment}${msg}`
        } else if (type === 'debug') {
            return colors.dim(`[debug] ${msg}`)
        } else if (type === 'error') {
            return `${colors.red(symbols.error)} ${msg}`
        } else if (type === 'warn') {
            return `${colors.yellow(symbols.warning)} ${msg}`
        } else {
            return msg
        }
    }

    function output(type: LogType, msg: string, options: LogErrorOptions = {}) {
        if (thresh >= LogLevels[type]) {
            const method = type === 'info' || type === 'debug' ? 'log' : type

            if (options.error) {
                loggedErrors.add(options.error)
            }
            if (canClearScreen) {
                if (type === lastType && msg === lastMsg) {
                    sameCount++
                    clear()
                    console[method](
                        format(type, msg, options),
                        colors.yellow(`(x${sameCount + 1})`),
                    )
                } else {
                    sameCount = 0
                    lastMsg = msg
                    lastType = type
                    if (options.clear) {
                        clear()
                    }
                    console[method](format(type, msg, options))
                }
            } else {
                console[method](format(type, msg, options))
            }
        }
    }

    const warnedMessages = new Set<string>()

    const logger: Logger = {
        hasWarned: false,
        level: level,
        debug(msg, opts) {
            output('debug', msg, opts)
        },
        info(msg, opts) {
            output('info', msg, opts)
        },
        warn(msg, opts) {
            logger.hasWarned = true
            output('warn', msg, opts)
        },
        warnOnce(msg, opts) {
            if (warnedMessages.has(msg)) return
            logger.hasWarned = true
            output('warn', msg, opts)
            warnedMessages.add(msg)
        },
        error(msg, opts) {
            logger.hasWarned = true
            output('error', msg, opts)
        },
        clearScreen(type) {
            if (thresh >= LogLevels[type]) {
                clear()
            }
        },
        hasErrorLogged(error) {
            return loggedErrors.has(error)
        },
        section(title) {
            if (thresh >= LogLevels['info']) {
                console.log(`\n${colors.cyan(symbols.section)} ${colors.bold(title)}\n`)
            }
        },
        success(msg) {
            if (thresh >= LogLevels['info']) {
                console.log(`  ${colors.green(symbols.success)} ${msg}`)
            }
        },
        done(msg) {
            if (thresh >= LogLevels['info']) {
                console.log(`\n${colors.green(symbols.success)} ${colors.bold(msg || 'Done')}\n`)
            }
        },
    }

    return logger
}
//
// export function printServerUrls(
//     urls: ResolvedServerUrls,
//     optionsHost: string | boolean | undefined,
//     info: Logger['info'],
// ): void {
//     const colorUrl = (url: string) =>
//         colors.cyan(url.replace(/:(\d+)\//, (_, port) => `:${colors.bold(port)}/`))
//     for (const url of urls.local) {
//         info(`  ${colors.green('➜')}  ${colors.bold('Local')}:   ${colorUrl(url)}`)
//     }
//     for (const url of urls.network) {
//         info(`  ${colors.green('➜')}  ${colors.bold('Network')}: ${colorUrl(url)}`)
//     }
//     if (urls.network.length === 0 && optionsHost === undefined) {
//         info(
//             colors.dim(`  ${colors.green('➜')}  ${colors.bold('Network')}: use `) +
//             colors.bold('--host') +
//             colors.dim(' to expose'),
//         )
//     }
// }
