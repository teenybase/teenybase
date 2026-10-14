/**
 * Custom DNS resolver: tries Cloudflare/Google DNS (1.1.1.1, 8.8.8.8) first,
 * falls back to system resolver. Results cached for 5 minutes.
 *
 * Enabled by setting AUTO_DNS=1 env var. Useful in containers/CI where the
 * system DNS is broken. NOT recommended for general use — breaks VPNs and
 * corporate DNS. Node's default system resolver works in most environments.
 *
 * Usage: import './utils/custom-dns.js' (side-effect import in cli.ts)
 */
import { Resolver } from 'node:dns/promises'
import { lookup as systemLookup } from 'node:dns'
import { setGlobalDispatcher, Agent } from 'undici'

type DnsResult = { address: string; family: number }[]
const cache = new Map<string, { addrs: DnsResult; ts: number }>()
const CACHE_TTL = 5 * 60 * 1000
const resolver = new Resolver()
resolver.setServers(['1.1.1.1', '8.8.8.8'])
const debug = !!process.env.DNS_DEBUG

async function resolve(hostname: string): Promise<DnsResult> {
    const cached = cache.get(hostname)
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
        if (debug) console.log(`[dns] cache hit: ${hostname} → ${cached.addrs[0]?.address}`)
        return cached.addrs
    }

    let addrs: DnsResult | undefined
    try {
        if (debug) console.log(`[dns] resolve4 ${hostname} via 1.1.1.1...`)
        const r = await Promise.race([resolver.resolve4(hostname), new Promise<never>((_, rej) => setTimeout(rej, 2000))])
        addrs = r.map(a => ({ address: a, family: 4 }))
        if (debug) console.log(`[dns] resolve4 ok: ${addrs[0]?.address}`)
    } catch {
        try {
            if (debug) console.log(`[dns] resolve6 ${hostname} via 1.1.1.1...`)
            const r = await Promise.race([resolver.resolve6(hostname), new Promise<never>((_, rej) => setTimeout(rej, 2000))])
            addrs = r.map(a => ({ address: a, family: 6 }))
            if (debug) console.log(`[dns] resolve6 ok: ${addrs[0]?.address}`)
        } catch {}
    }
    if (!addrs) {
        if (debug) console.log(`[dns] falling back to system resolver for ${hostname}...`)
        addrs = await new Promise<DnsResult>((res, rej) =>
            systemLookup(hostname, { all: true }, (err, results) =>
                err || !results?.length ? rej(err) : res(results.map(a => ({ address: a.address, family: a.family })))
            )
        )
        if (debug) console.log(`[dns] system resolver ok: ${addrs[0]?.address}`)
    }
    cache.set(hostname, { addrs, ts: Date.now() })
    return addrs
}

setGlobalDispatcher(new Agent({
    connect: {
        lookup: (hostname, _options, cb) => {
            resolve(hostname).then(addrs => cb(null, addrs), err => cb(err, []))
        },
    },
}))
