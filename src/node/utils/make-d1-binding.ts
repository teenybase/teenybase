import makeBinding, {ResultsFormat} from '../cloudflare/d1-api';
import {URL} from 'url';
import {replaceSqlPlaceholders} from './replaceSqlPlaceholders';
import fs from 'node:fs';
import path from 'node:path';
import {CliContext} from '../cli-utils';

export function makeD1Binding(c: CliContext) {
    const d1 = makeBinding({
        fetcher: {
            // @ts-expect-error
            async fetch(
                input: string | URL | Request,
                init?: RequestInit,
            ): Promise<Response> {
                const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
                if (!body) throw new Error('Request body is required to execute SQL command')
                const url1 = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
                const url = new URL(url1)
                if (url.origin !== 'http://d1') throw new Error('Only http://d1 origin is supported in D1 fetcher')
                // `run()` sends one statement to /execute. `batch()` (an array of statements) and
                // first()/all()/raw() use /query: not supported, see issues/open/cli-direct-d1-batch-unsupported.md.
                if (Array.isArray(body)) throw new Error(`Batches (${body.length} statements) are not supported by the CLI's direct D1 path (wrangler d1 execute): it runs single statements only`)
                if (!url.pathname.endsWith('/execute')) throw new Error(`Only single statements through run() (/execute) are supported by the CLI's direct D1 path (wrangler d1 execute), not ${url.pathname}`)
                const resultsFormat = (url.searchParams.get('resultsFormat') || 'NONE') as ResultsFormat
                if (resultsFormat !== 'NONE') throw new Error('Only resultsFormat=NONE is supported in D1 fetcher')

                // Replace ? placeholders with actual parameter values for command line execution
                const sql = (body.params && Array.isArray(body.params) && body.params.length > 0)
                    ? replaceSqlPlaceholders(body.sql, body.params)
                    : body.sql

                // Log the SQL being executed — truncate long queries
                const sqlPreview = body.sql.length > 200 ? body.sql.slice(0, 200) + '...' : body.sql
                const paramsPreview = body.params?.length ? ` [${body.params.length} params]` : ''
                c.logger.debug(`SQL: ${sqlPreview}${paramsPreview}`)

                const args = [
                    'd1', 'execute',
                    `--config=${c.wranglerConfig.config.path}`,
                    c.wranglerConfig.db.binding,
                    ...(c.isLocal
                        ? [`--persist-to=${c.localPersistPath}`, '--local']
                        : ['--remote']),
                    '--yes',
                    '--json',
                    `--command=${sql}`,
                ];

                // ${c.isLocal ? '--local' : '--remote'} \
                let result

                try {
                    c.logger.debug('Executing: wrangler d1 execute ' + (c.isLocal ? '--local' : '--remote'))
                    const cdRes = (await c.runWrangler(args, {echo: false})).stdout
                    if (cdRes.length > 500) {
                        const tmpPath = path.join(c.root, '.teeny', 'd1-debug.log')
                        fs.mkdirSync(path.dirname(tmpPath), {recursive: true})
                        fs.appendFileSync(tmpPath, `\n--- ${new Date().toISOString()} SQL: ${sqlPreview} ---\n${cdRes}\n`)
                        c.logger.debug(`Command output appended to file://${tmpPath} (${cdRes.length} chars)`)
                    } else {
                        c.logger.debug('Command output: ' + cdRes)
                    }
                    result = JSON.parse(cdRes)
                } catch (e: any) {
                    const cdRes = e?.stdout?.toString() || ''
                    c.logger.debug('Command exit status: ' + e?.status)
                    if (cdRes.length > 500) {
                        const tmpPath = path.join(c.root, '.teeny', 'd1-debug.log')
                        fs.mkdirSync(path.dirname(tmpPath), {recursive: true})
                        fs.appendFileSync(tmpPath, `\n--- ${new Date().toISOString()} ERROR SQL: ${sqlPreview} ---\n${cdRes}\n`)
                        c.logger.debug(`Command error output appended to file://${tmpPath} (${cdRes.length} chars)`)
                    } else {
                        c.logger.debug('Command output: ' + cdRes)
                    }

                    try {
                        result = JSON.parse(cdRes)
                        if (!result.error || result.error.name !== 'APIError') {
                            throw new Error('UNSUPPORTED_ERROR_FORMAT')
                        }
                    } catch (e1) {
                        const err = [e?.stderr, e?.stdout].filter(Boolean).join('\n') || e?.message || 'unknown error'
                        c.logger.debug(`Error executing D1 command, status - ${e?.status}. ${err}`)
                        throw new Error(`Error executing D1 command: ${err}`)
                    }
                    // {
                    //   "error": {
                    //     "text": "A request to the Cloudflare API (/accounts/xxx/d1/database/xxx/query) failed.",
                    //     "notes": [
                    //       {
                    //         "text": "no such table: _db_migrations: SQLITE_ERROR [code: 7500]"
                    //       }
                    //     ],
                    //     "kind": "error",
                    //     "name": "APIError",
                    //     "code": 7500,
                    //     "accountTag": "xxx"
                    //   }
                    // }
                    let message = result.error.notes?.map((n: any) => n.text).join(' ') || result.error.text || 'Unknown error'

                    result = {
                        success: false,
                        error: message,
                        meta: {},
                    }

                }

                // The expected request format is:

                // http://d1/execute?resultsFormat=NONE {
                //   method: 'POST',
                //   headers: Headers {
                //     'content-type': 'application/json',
                //     'x-cf-d1-session-commit-token': 'first-primary'
                //   },
                //   body: '{"sql":"SELECT id, name, sql, sql_revert FROM _db_migrations","params":[]}'
                // }

                // Response: `wrangler d1 execute --json` prints an array with one
                // `{results, success, meta}` per statement, the same shape the D1 service answers
                // /execute with (miniflare's D1 object returns `queries.map(...)` for one statement
                // too), so it is passed through; d1-api.ts takes the first entry for run(). A wrangler
                // error is turned into one `{success: false, error}` above.
                return new Response(JSON.stringify(result), {
                    headers: {
                        'Content-Type': 'application/json',
                    }
                })
            }
        }
    })
    return d1
}
