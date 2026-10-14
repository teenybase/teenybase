// Shared error class and retry utilities for REST adapters (R2RestAdapter,
// D1RestAdapter, etc.).
//
// Retry policy:
//   - 401/403: throw immediately (auth failure, caller must rotate token)
//   - 429:     backoff honouring Retry-After (max 5 retries, 30 s budget)
//   - 5xx + network: retry with jitter (max 3 attempts, 30 s budget)
//   - other 4xx: throw immediately (client error, retrying won't help)
//
// `code` is the upstream error code (CF API `errors[0].code`, S3 `<Code>`,
// or a synthesised string like `network`/`http_${status}`) so callers can
// branch on machine-readable identifiers without parsing the message.

export class RestAdapterError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "RestAdapterError"
    this.status = status
    this.code = code
  }
}

/** Sleep with cancellation-friendly setTimeout. Used by retry loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Compute a retry delay with full jitter (AWS-recommended).
 *  base * 2^attempt, capped, then random in [0, that]. */
export function jitterDelay(attempt: number, baseMs = 200, capMs = 5000): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt)
  return Math.floor(Math.random() * exp)
}

/** Parse a Retry-After header (RFC 7231): seconds (integer) or HTTP-date.
 *  Returns ms, or null if absent/invalid. */
export function parseRetryAfter(h: string | null): number | null {
  if (!h) return null
  const trimmed = h.trim()
  if (/^\d+$/.test(trimmed)) {
    const s = Number(trimmed)
    return Number.isFinite(s) ? s * 1000 : null
  }
  const t = Date.parse(trimmed)
  if (!Number.isFinite(t)) return null
  const delta = t - Date.now()
  return delta > 0 ? delta : 0
}

/** Decide whether an HTTP status should be retried.
 *  401/403: never. 429: yes. 5xx: yes. Other 4xx: no. */
export function isRetriableStatus(status: number): boolean {
  if (status === 401 || status === 403) return false
  if (status === 429) return true
  return status >= 500 && status <= 599
}

/** Shared retry loop for REST adapters. Caller supplies an idempotent request
 *  thunk and a status-error thrower. Honours the retry policy: 429 up to 5
 *  attempts honouring Retry-After, 5xx + network up to 3 attempts with jitter,
 *  30 s total budget. 401/403/other-4xx propagate via `onStatusError`. */
export async function retryFetch(
  exec: () => Promise<Response>,
  onStatusError: (res: Response) => Promise<never>,
  label: string,
): Promise<Response> {
  const RETRY_BUDGET_MS = 30_000
  const MAX_429 = 5
  const MAX_5XX = 3
  let totalWait = 0, retries429 = 0, retries5xx = 0

  while (true) {
    let res: Response
    try {
      res = await exec()
    } catch (e) {
      if (retries5xx >= MAX_5XX) {
        throw new RestAdapterError(0, "network", `${label}: network error: ${(e as Error).message}`)
      }
      const delay = jitterDelay(retries5xx)
      if (totalWait + delay > RETRY_BUDGET_MS) {
        throw new RestAdapterError(0, "network", `${label}: network error (budget exhausted): ${(e as Error).message}`)
      }
      await sleep(delay); totalWait += delay; retries5xx++; continue
    }

    if (res.ok) return res
    if (!isRetriableStatus(res.status)) await onStatusError(res)

    if (res.status === 429) {
      if (retries429 >= MAX_429) await onStatusError(res)
      const ra = parseRetryAfter(res.headers.get("Retry-After")) ?? jitterDelay(retries429, 500, 5000)
      if (totalWait + ra > RETRY_BUDGET_MS) await onStatusError(res)
      try { await res.body?.cancel() } catch { /* already drained */ }
      await sleep(ra); totalWait += ra; retries429++
    } else {
      if (retries5xx >= MAX_5XX) await onStatusError(res)
      const delay = jitterDelay(retries5xx)
      if (totalWait + delay > RETRY_BUDGET_MS) await onStatusError(res)
      try { await res.body?.cancel() } catch { /* already drained */ }
      await sleep(delay); totalWait += delay; retries5xx++
    }
  }
}
