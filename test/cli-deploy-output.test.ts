import {describe, expect, test} from 'vitest'
import {deployedAddresses} from '../src/node/cli-utils'

// wrangler deploy prints one indented line per target after "Deployed <name> triggers", before "Current Version ID:".
const out = (targets: string[]) => [
    'Total Upload: 1318.85 KiB / gzip: 245.64 KiB',
    'Uploaded my-app (7.68 sec)',
    'Deployed my-app triggers (2.02 sec)',
    ...targets.map(t => '  ' + t),
    'Current Version ID: 1fc76366-b63f-4f39-afec-98aa16170f68',
].join('\r\n')

describe('deployedAddresses', () => {
    test('finds the workers.dev URL when cron schedules follow it (0.1.0 lost it)', () => {
        expect(deployedAddresses(out(['https://my-app.acme.workers.dev', 'schedule: 17 3 * * *', 'schedule: 0 * * * *'])))
            .toEqual(['https://my-app.acme.workers.dev'])
    })
    test('workers.dev first, then custom domains as https URLs; zone routes are left out', () => {
        expect(deployedAddresses(out(['app.example.com (custom domain)', 'example.com/api/* (zone name: example.com)', 'https://my-app.acme.workers.dev'])))
            .toEqual(['https://my-app.acme.workers.dev', 'https://app.example.com'])
    })
    test('workers.dev off: only the custom domains; ANSI codes are ignored', () => {
        expect(deployedAddresses(out(['\x1B[32mcloud.example.org (custom domain)\x1B[0m', 'files.example.org (custom domain)'])))
            .toEqual(['https://cloud.example.org', 'https://files.example.org'])
    })
})
