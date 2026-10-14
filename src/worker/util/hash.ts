// SHA-256 hex helper for SigV4 signing and general use. Uses the Web Crypto
// API (available in both Cloudflare Workers and Node 18+).

export function bytesToHex(u: Uint8Array): string {
  let s = ""
  for (let i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, "0")
  return s
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input
  const hash = await crypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer)
  return bytesToHex(new Uint8Array(hash))
}
