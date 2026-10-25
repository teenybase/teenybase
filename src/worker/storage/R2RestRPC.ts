// R2RestRPC — WorkerEntrypoint wrapping R2RestAdapter for cross-isolate use
// under LOADER. The managed backend forwards R2 operations to user project
// buckets through this entrypoint; LOADER can't serialize native R2 bindings,
// so we reconstruct the adapter from props on the receiving side.
//
// Methods mirror the R2Bucket surface: head / get / put / delete / list.

import { WorkerEntrypoint } from "cloudflare:workers"
import { R2RestAdapter } from "./R2RestAdapter"

export interface R2RestRPCProps {
  accountId: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  jurisdiction?: "default" | "eu" | "fedramp"
  endpointOverride?: string
}

export class R2RestRPC extends WorkerEntrypoint<{}, R2RestRPCProps> {
  private _adapter: R2RestAdapter | null = null

  private adapter(): R2RestAdapter {
    if (this._adapter) return this._adapter
    const props = this.ctx.props
    if (!props || typeof props.accountId !== "string") {
      throw new Error("R2RestRPC: missing or invalid props (need accountId, bucket, accessKeyId, secretAccessKey)")
    }
    this._adapter = new R2RestAdapter({
      accountId: props.accountId,
      bucket: props.bucket,
      accessKeyId: props.accessKeyId,
      secretAccessKey: props.secretAccessKey,
      jurisdiction: props.jurisdiction,
      endpointOverride: props.endpointOverride,
    })
    return this._adapter
  }

  async head(key: string) {
    return await this.adapter().head(key)
  }

  async get(key: string, options?: unknown) {
    const a = this.adapter() as unknown as { get: (k: string, o?: unknown) => Promise<unknown> }
    return await a.get(key, options)
  }

  // RPC can't carry a File or Blob, and caps other values at 32 MiB; file uploads use putStream.
  async put(key: string, body: ArrayBuffer | Uint8Array | string, options?: unknown) {
    const a = this.adapter() as unknown as { put: (k: string, b: unknown, o?: unknown) => Promise<unknown> }
    return await a.put(key, body, options)
  }

  // Not part of R2Bucket. $Database.putFileObject calls it for File/Blob uploads, sending
  // file.stream() and file.size; streams cross RPC without the 32 MiB limit.
  async putStream(key: string, stream: ReadableStream, size: number, options?: R2PutOptions) {
    return await this.adapter().putStream(key, stream, size, options)
  }

  async delete(keys: string | string[]) {
    return await this.adapter().delete(keys)
  }

  async list(options?: unknown) {
    const a = this.adapter() as unknown as { list: (o?: unknown) => Promise<unknown> }
    return await a.list(options)
  }
}
