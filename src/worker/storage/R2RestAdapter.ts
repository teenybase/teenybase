// R2RestAdapter — R2Bucket implementation backed by R2's S3-compatible REST
// API with hand-rolled SigV4 signing. Designed so a loader can inject this in
// place of a native R2 binding, letting user code read/write a remote bucket
// transparently.
//
// Endpoint: https://{accountId}.r2.cloudflarestorage.com/{bucket}/{key}
// Region "auto", service "s3". Streaming: get().body returns Response.body
// directly. v0 uses single-shot PUT (cap 5 GiB); multipart is a TODO.

import { RestAdapterError, retryFetch } from "./RestAdapterError"
import { sha256Hex, bytesToHex } from "../util/hash"

export interface R2RestAdapterOptions {
  accountId: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  jurisdiction?: "default" | "eu" | "fedramp"
  fetch?: typeof fetch
  /** Optional base URL override (e.g. `http://127.0.0.1:8745` for a local
   *  simulator). When set, replaces the `https://<acct>.r2.cloudflarestorage.com`
   *  scheme+host. The Host header used in SigV4 signing keeps the canonical R2
   *  host so signatures are still well-formed; a sim that doesn't validate
   *  signatures will accept them, real CF would 403 anyway. */
  endpointOverride?: string
}

const REGION = "auto"
const SERVICE = "s3"
const enc = new TextEncoder()

export class R2RestAdapter {
  private readonly host: string
  /** Scheme+host actually used for the HTTP request. Same as `this.host`
   *  in production; replaced by `endpointOverride` for local sims. */
  private readonly endpoint: string
  private readonly bucket: string
  private readonly accessKeyId: string
  private readonly secretAccessKey: string
  private readonly fetchFn: typeof fetch

  constructor(opts: R2RestAdapterOptions) {
    if (!opts.accountId) throw new Error("R2RestAdapter: accountId required")
    if (!opts.bucket) throw new Error("R2RestAdapter: bucket required")
    if (!opts.accessKeyId) throw new Error("R2RestAdapter: accessKeyId required")
    if (!opts.secretAccessKey) throw new Error("R2RestAdapter: secretAccessKey required")
    const sub = opts.jurisdiction === "eu" ? ".eu" : opts.jurisdiction === "fedramp" ? ".fedramp" : ""
    this.host = `${opts.accountId}${sub}.r2.cloudflarestorage.com`
    this.endpoint = opts.endpointOverride
      ? opts.endpointOverride.replace(/\/+$/, "")
      : `https://${this.host}`
    this.bucket = opts.bucket
    this.accessKeyId = opts.accessKeyId
    this.secretAccessKey = opts.secretAccessKey
    const f = opts.fetch ?? globalThis.fetch
    this.fetchFn = f.bind(globalThis)
  }

  async head(key: string): Promise<R2Object | null> {
    const res = await this.send("HEAD", key)
    if (res.status === 404) { try { await res.body?.cancel() } catch {}; return null }
    return metaFromHeaders(key, res.headers)
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    const headers = onlyIfHeaders((options as any)?.onlyIf)
    const range = (options as any)?.range
    if (range?.suffix != null) headers["range"] = `bytes=-${range.suffix}`
    else if (range && ("offset" in range || "length" in range)) {
      const off = range.offset ?? 0
      headers["range"] = `bytes=${off}-${range.length != null ? off + range.length - 1 : ""}`
    }
    const res = await this.send("GET", key, { headers })
    if (res.status === 404 || res.status === 304 || res.status === 412) {
      try { await res.body?.cancel() } catch {}
      return res.status === 404 ? null : (metaFromHeaders(key, res.headers) as unknown as R2ObjectBody)
    }
    return attachBody(metaFromHeaders(key, res.headers), res)
  }

  async put(
    key: string,
    body: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    const headers = httpMetaToHeaders(options?.httpMetadata as R2HTTPMetadata | undefined)
    if (options?.customMetadata) {
      for (const [k, v] of Object.entries(options.customMetadata)) {
        headers[`x-amz-meta-${k.toLowerCase()}`] = String(v)
      }
    }
    Object.assign(headers, onlyIfHeaders((options as any)?.onlyIf))
    // SigV4 payload hash: buffered bodies get a real SHA-256; streams use
    // UNSIGNED-PAYLOAD (sigv4 escape hatch supported by R2).
    let payloadHash: string
    if (typeof body === "string") payloadHash = await sha256Hex(body)
    else if (body instanceof ArrayBuffer) payloadHash = await sha256Hex(new Uint8Array(body))
    else if (ArrayBuffer.isView(body)) {
      const v = body as ArrayBufferView
      payloadHash = await sha256Hex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
    } else if (body == null) payloadHash = await sha256Hex(new Uint8Array(0))
    else payloadHash = "UNSIGNED-PAYLOAD"
    const res = await this.send("PUT", key, { headers, body: (body ?? "") as BodyInit, payloadHash })
    try { await res.body?.cancel() } catch {}
    return metaFromHeaders(key, res.headers, options)
  }

  async delete(key: string): Promise<void> {
    // R2 DELETE is idempotent: 204/200 success, 404 also treated as success.
    const res = await this.send("DELETE", key)
    try { await res.body?.cancel() } catch {}
    if (res.status === 404 || (res.status >= 200 && res.status < 300)) return
    await throwForStatus(res, "DELETE", key) // retryFetch already handled retriable cases
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const qs = new URLSearchParams({ "list-type": "2" })
    if (options?.prefix) qs.set("prefix", options.prefix)
    if (options?.cursor) qs.set("continuation-token", options.cursor)
    if (options?.limit != null) qs.set("max-keys", String(Math.min(1000, options.limit)))
    if ((options as any)?.delimiter) qs.set("delimiter", (options as any).delimiter)
    if ((options as any)?.startAfter) qs.set("start-after", (options as any).startAfter)

    const xml = await (await this.send("GET", "", { query: qs.toString() })).text()
    const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml)
    const cursor = matchTag(xml, "NextContinuationToken")
    const objects = [...allTags(xml, "Contents")].map(b => makeR2Object({
      key: matchTag(b, "Key") ?? "",
      size: Number(matchTag(b, "Size") ?? "0"),
      etag: (matchTag(b, "ETag") ?? "").replace(/^"|"$/g, ""),
      uploaded: new Date(matchTag(b, "LastModified") ?? 0),
    }))
    const delimitedPrefixes: string[] = []
    for (const b of allTags(xml, "CommonPrefixes")) { const p = matchTag(b, "Prefix"); if (p) delimitedPrefixes.push(p) }
    return truncated
      ? ({ objects, truncated: true, cursor: cursor ?? undefined, delimitedPrefixes } as unknown as R2Objects)
      : ({ objects, truncated: false, delimitedPrefixes } as unknown as R2Objects)
  }

  private async send(
    method: string, key: string,
    opts?: { headers?: Record<string, string>; body?: BodyInit; query?: string; payloadHash?: string },
  ): Promise<Response> {
    const url = `${this.endpoint}/${this.bucket}${key ? "/" + s3EncodePath(key) : "/"}${opts?.query ? "?" + opts.query : ""}`
    const payloadHash = opts?.payloadHash ?? "UNSIGNED-PAYLOAD"
    const signed = await signV4({
      method, url, payloadHash,
      headers: { host: this.host, "x-amz-content-sha256": payloadHash, ...(opts?.headers ?? {}) },
      accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey,
      region: REGION, service: SERVICE,
    })
    // When the endpoint is overridden (e.g. local sim), undici/node fetch
    // ignores any user-supplied `host:` header and sets it from the URL
    // (`127.0.0.1:8745`). Pass the canonical CF Host via a custom header
    // so the sim can still extract the account id. Production CF receives
    // the canonical host via signing.
    if (this.endpoint !== `https://${this.host}`) {
      const accountId = this.host.split(".")[0]
      if (accountId) signed["x-sim-account-id"] = accountId
    }
    return retryFetch(() => this.fetchFn(url, { method, headers: signed, body: opts?.body }),
      res => throwForStatus(res, method, key), "R2RestAdapter")
  }
}

/** Factory that returns an R2Bucket-typed wrapper. The cast is sound because
 *  R2RestAdapter dispatches on the same option shapes the binding's overloads
 *  expect. */
export function createR2RestBucket(opts: R2RestAdapterOptions): R2Bucket {
  return new R2RestAdapter(opts) as unknown as R2Bucket
}

// ── helpers ────────────────────────────────────────────────────────────────

async function throwForStatus(res: Response, method: string, key: string): Promise<never> {
  let code = `http_${res.status}`, message = res.statusText || `R2 ${method} ${key} failed`
  try {
    const xml = await res.text()
    code = matchTag(xml, "Code") ?? code
    message = matchTag(xml, "Message") ?? message
  } catch { /* non-XML */ }
  throw new RestAdapterError(res.status, code, `R2RestAdapter: ${method} ${key}: ${message}`)
}

function httpMetaToHeaders(m?: R2HTTPMetadata): Record<string, string> {
  const h: Record<string, string> = {}
  if (!m) return h
  if (m.contentType) h["content-type"] = m.contentType
  if (m.contentLanguage) h["content-language"] = m.contentLanguage
  if (m.contentDisposition) h["content-disposition"] = m.contentDisposition
  if (m.contentEncoding) h["content-encoding"] = m.contentEncoding
  if (m.cacheControl) h["cache-control"] = m.cacheControl
  if (m.cacheExpiry) h["expires"] = new Date(m.cacheExpiry).toUTCString()
  return h
}

function metaFromHeaders(key: string, h: Headers, putOpts?: R2PutOptions): R2Object {
  const customMetadata: Record<string, string> = putOpts?.customMetadata
    ? { ...(putOpts.customMetadata as Record<string, string>) } : {}
  if (!putOpts?.customMetadata) {
    h.forEach((v, k) => { if (k.toLowerCase().startsWith("x-amz-meta-")) customMetadata[k.slice(11)] = v })
  }
  const httpMetadata: R2HTTPMetadata = (putOpts?.httpMetadata as R2HTTPMetadata) ?? {
    contentType: h.get("content-type") ?? undefined,
    contentLanguage: h.get("content-language") ?? undefined,
    contentDisposition: h.get("content-disposition") ?? undefined,
    contentEncoding: h.get("content-encoding") ?? undefined,
    cacheControl: h.get("cache-control") ?? undefined,
    cacheExpiry: h.get("expires") ? new Date(h.get("expires")!) : undefined,
  }
  return makeR2Object({
    key, size: Number(h.get("content-length") ?? "0"),
    etag: (h.get("etag") ?? "").replace(/^"|"$/g, ""),
    uploaded: h.get("last-modified") ? new Date(h.get("last-modified")!) : new Date(),
    httpMetadata, customMetadata,
  })
}

// R2Object isn't directly constructible at runtime; return a structurally
// compatible object. writeHttpMetadata() is included since user code calls it.
function makeR2Object(p: {
  key: string; size: number; etag: string; uploaded: Date
  httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string>
}): R2Object {
  const o: any = {
    key: p.key, version: "", size: p.size, etag: p.etag, httpEtag: `"${p.etag}"`,
    checksums: {} as R2Checksums, uploaded: p.uploaded,
    httpMetadata: p.httpMetadata ?? {}, customMetadata: p.customMetadata ?? {},
    storageClass: "Standard", range: undefined,
    writeHttpMetadata(h: Headers) { for (const [k, v] of Object.entries(httpMetaToHeaders(p.httpMetadata))) h.set(k, v) },
  }
  return o as R2Object
}

function attachBody(meta: R2Object, res: Response): R2ObjectBody {
  const w: any = meta
  let used = false
  const stream = res.body ?? new ReadableStream({ start(c) { c.close() } })
  Object.defineProperty(w, "body", { value: stream, enumerable: true })
  Object.defineProperty(w, "bodyUsed", { get: () => used })
  for (const k of ["arrayBuffer", "text", "json", "blob"] as const) {
    w[k] = async () => { used = true; return (res as any)[k]() }
  }
  return w as R2ObjectBody
}

function quoteEtag(e: string): string { return /^".*"$/.test(e) ? e : `"${e}"` }

function onlyIfHeaders(o: any): Record<string, string> {
  const h: Record<string, string> = {}
  if (!o) return h
  if (o.etagMatches) h["if-match"] = quoteEtag(o.etagMatches)
  if (o.etagDoesNotMatch) h["if-none-match"] = quoteEtag(o.etagDoesNotMatch)
  if (o.uploadedBefore) h["if-unmodified-since"] = new Date(o.uploadedBefore).toUTCString()
  if (o.uploadedAfter) h["if-modified-since"] = new Date(o.uploadedAfter).toUTCString()
  return h
}

function matchTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return m ? m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'") : null
}

function* allTags(xml: string, tag: string): Generator<string> {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) yield m[1]
}

function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase())
}
// S3 path-segment encoding: rfc3986 each segment, preserve '/'.
function s3EncodePath(key: string): string { return key.split("/").map(rfc3986).join("/") }

// ── SigV4 (hand-rolled) ───────────────────────────────────────────────────

async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = key instanceof Uint8Array ? key : new Uint8Array(key)
  const ck = await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return crypto.subtle.sign("HMAC", ck, enc.encode(msg))
}

async function signV4(args: {
  method: string; url: string; headers: Record<string, string>; payloadHash: string
  accessKeyId: string; secretAccessKey: string; region: string; service: string
}): Promise<Record<string, string>> {
  const u = new URL(args.url)
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "") // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8)
  const headers: Record<string, string> = { ...args.headers, "x-amz-date": amzDate }
  // Canonical headers: lowercase, trim, sort.
  const canonHdrs = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")] as [string, string])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  const canonicalHeaders = canonHdrs.map(([k, v]) => `${k}:${v}\n`).join("")
  const signedHeaders = canonHdrs.map(([k]) => k).join(";")
  // Canonical query: sort by key then value, RFC3986-encode.
  const params: [string, string][] = []
  u.searchParams.forEach((v, k) => params.push([k, v]))
  params.sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
  const canonicalQuery = params.map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join("&")
  const canonicalRequest = [args.method.toUpperCase(), u.pathname || "/", canonicalQuery, canonicalHeaders, signedHeaders, args.payloadHash].join("\n")
  const credentialScope = `${dateStamp}/${args.region}/${args.service}/aws4_request`
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, await sha256Hex(enc.encode(canonicalRequest))].join("\n")
  const kDate = await hmac(enc.encode("AWS4" + args.secretAccessKey), dateStamp)
  const kRegion = await hmac(kDate, args.region)
  const kService = await hmac(kRegion, args.service)
  const kSigning = await hmac(kService, "aws4_request")
  const sig = bytesToHex(new Uint8Array(await hmac(kSigning, stringToSign)))
  headers["authorization"] = `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`
  return headers
}
