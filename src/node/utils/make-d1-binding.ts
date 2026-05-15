import makeBinding, {ResultsFormat} from '../cloudflare/d1-api';
import {URL} from 'url';
import {replaceSqlPlaceholders} from './replaceSqlPlaceholders';
import {execFileSync} from 'node:child_process';
import {CliContext} from '../cli-utils';

export function makeD1Binding(c: CliContext) {
    const d1 = makeBinding({
        fetcher: {
            // @ts-expect-error
            async fetch(
                input: string | URL | Request,
                init?: RequestInit,
            ): Promise<Response> {
                c.logger.debug(JSON.stringify(input))
                c.logger.debug(JSON.stringify(init || {}))

                const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
                if (!body) throw new Error('Request body is required to execute SQL command')
                const url1 = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
                const url = new URL(url1)
                if (!url.pathname.endsWith('/execute')) throw new Error('Only /execute endpoint is supported in D1 fetcher')
                const resultsFormat = (url.searchParams.get('resultsFormat') || 'NONE') as ResultsFormat
                if (resultsFormat !== 'NONE') throw new Error('Only resultsFormat=NONE is supported in D1 fetcher')
                if (url.origin !== 'http://d1') throw new Error('Only http://d1 origin is supported in D1 fetcher')

                // Replace ? placeholders with actual parameter values for command line execution
                const sql = (body.params && Array.isArray(body.params) && body.params.length > 0)
                    ? replaceSqlPlaceholders(body.sql, body.params)
                    : body.sql

                const args = [
                    'wrangler', 'd1', 'execute',
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
                    c.logger.debug('Executing command: npx ' + args.join(' '))
                    const cdRes = execFileSync('npx', args, {
                        cwd: c.root,
                        stdio: ['inherit', 'pipe', 'pipe'],
                        shell: true
                    }).toString()
                    c.logger.debug('Command output: ' + cdRes)
                    result = JSON.parse(cdRes)
                } catch (e: any) {
                    const cdRes = e?.stdout?.toString() || ''
                    c.logger.debug('Command exit status: ' + e?.status)
                    c.logger.debug('Command output: ' + cdRes)

                    try {
                        result = JSON.parse(cdRes)
                        if (!result.error || result.error.name !== 'APIError') {
                            throw new Error('UNSUPPORTED_ERROR_FORMAT')
                        }
                    } catch (e1) {
                        const err = '' + e?.stderr + '' + e?.stdout
                        c.logger.error(`Error executing D1 command, status - ${e.status}\n${err}`)
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

                // executeSql({
                //     local: c.isLocal,
                //     remote: !c.isLocal,
                //     accountId: '',
                //
                // })
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
