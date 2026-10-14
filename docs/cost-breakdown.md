# Cost Breakdown

> Last verified: 2026-05-14. Cloudflare pricing may change — check the source links below for current rates.

Teenybase runs on Cloudflare infrastructure. This document shows the exact math behind the cost estimates in our README.

## Assumption

These calculations assume you are on the **Cloudflare Workers Paid plan ($5/month base)** and the included allowances are fully consumed by other apps or usage. Every number below uses **pure overage rates** — the worst case per-app cost.

If you only run 1-2 apps, most usage will fall within the included allowances and your actual cost will be lower (often just the $5 base).

## Cloudflare overage rates

| Resource | Rate | Source |
|----------|------|--------|
| Worker requests | $0.30 / million | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| D1 row reads | $0.001 / million | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 row writes | $1.00 / million | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 storage | $0.75 / GB-month | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| R2 storage | $0.015 / GB-month | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| R2 Class A ops (writes) | $4.50 / million | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| R2 Class B ops (reads) | $0.36 / million | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Egress (all) | $0 | Cloudflare never charges egress |

## Tier 1: Free ($0/month)

The Cloudflare free plan — no credit card, no trial, no expiry.

| Resource | Included |
|----------|----------|
| Worker requests | 100,000 / day (~3M / month) |
| D1 row reads | 5M / day |
| D1 row writes | 100k / day |
| D1 storage | 500 MB per database, 5 GB per account |
| R2 storage | 10 GB |
| R2 Class A ops | 1M / month |
| R2 Class B ops | 10M / month |

**Total: $0/month.** Enough for prototypes, side projects, and early-stage products.

## Tier 2: App with real users (~1,000 DAU) — under $1/month

A typical app with ~1,000 daily active users. Each user makes ~15 API calls/day, each call reads ~10 rows and occasionally writes.

| Resource | Usage | Rate | Cost |
|----------|-------|------|------|
| Requests | 450k / month | $0.30 / million | $0.14 |
| D1 row reads | 4.5M / month | $0.001 / million | $0.005 |
| D1 row writes | 90k / month | $1.00 / million | $0.09 |
| D1 storage | 500 MB | $0.75 / GB | $0.38 |
| R2 storage | 2 GB | $0.015 / GB | $0.03 |
| R2 Class A ops | 1k / month | $4.50 / million | $0.005 |
| R2 Class B ops | 90k / month | $0.36 / million | $0.03 |
| **Total** | | | **$0.68/month** |

### How we estimated the usage

- 1,000 DAU × 15 API calls/day × 30 days = 450k requests/month
- Each API call reads ~10 database rows on average = 4.5M row reads/month
- ~10% of calls are writes, averaging 2 rows each = 90k row writes/month
- 500 MB database covers ~500k–1M records depending on schema
- 2 GB file storage (profile images, uploads)
- R2 writes: ~1 file upload per user/month = 1k Class A ops
- R2 reads: ~3 file reads per user/day = 1k × 3 × 30 = 90k Class B ops

## Tier 3: Production SaaS (~10,000 DAU) — $5-10/month

A production app with thousands of active users, heavier queries, and more file storage.

| Resource | Usage | Rate | Cost |
|----------|-------|------|------|
| Requests | 5M / month | $0.30 / million | $1.50 |
| D1 row reads | 50M / month | $0.001 / million | $0.05 |
| D1 row writes | 1M / month | $1.00 / million | $1.00 |
| D1 storage | 5 GB | $0.75 / GB | $3.75 |
| R2 storage | 50 GB | $0.015 / GB | $0.75 |
| R2 Class A ops | 10k / month | $4.50 / million | $0.05 |
| R2 Class B ops | 900k / month | $0.36 / million | $0.32 |
| **Total** | | | **$7.42/month** |

### How we estimated the usage

- 10,000 DAU × ~17 API calls/day × 30 days = 5M requests/month
- Each API call reads ~10 rows on average (list queries read more, single-record reads less) = 50M row reads/month
- ~7% of calls are writes, averaging 3 rows each = 1M row writes/month
- 5 GB database covers several million records
- 50 GB file storage (documents, images, media)
- R2 writes: ~1 file upload per user/month = 10k Class A ops
- R2 reads: ~3 file reads per user/day = 10k × 3 × 30 = 900k Class B ops

## What's always free

Regardless of plan:

- **Egress** — Cloudflare never charges for bandwidth out
- **Teenybase itself** — open source, Apache-2.0, no license fees
- **Auth, API rules, OpenAPI docs, admin panel** — all included, no per-feature charges

## Workers Paid plan included allowances ($5/month base)

For reference, the $5/month base plan includes these shared across all your apps:

| Resource | Included |
|----------|----------|
| Worker requests | 10M / month |
| D1 row reads | 25B / month |
| D1 row writes | 50M / month |
| D1 storage | 5 GB |
| R2 storage | 10 GB (free tier, always available) |

If you run only 1-2 apps, most of your usage will fall within these included amounts and your actual cost will be close to just the $5 base.

## Notes

- All prices sourced from Cloudflare's public pricing pages (see links in rate table above).
- D1 max database size is 10 GB per database (hard limit). Account-wide storage limit is 1 TB on the paid plan.
- R2 free tier (10 GB storage, 1M Class A, 10M Class B) is always available regardless of Workers plan.
- Teenybase itself is free; you pay only the infrastructure costs listed above, directly to Cloudflare.

---

**See also:** [Why Teenybase](why-teenybase.md) | [Getting Started](getting-started.md) | [CLI Reference](cli.md)
