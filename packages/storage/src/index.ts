// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Object storage over the S3 API. Garage (AGPL, self-hosted) is the default;
 * any S3-compatible store works (MinIO, Ceph RGW, or commercial ones like R2)
 * through the same interface. Signing is SigV4 via aws4fetch.
 */
import { AwsClient } from "aws4fetch";

export interface PutOptions {
  contentType?: string;
  cacheControl?: string;
}

export interface GetOptions {
  /** An HTTP `Range` header value, passed through as is. */
  range?: string;
}

export interface ObjectInfo {
  key: string;
  size: number;
  etag: string;
  lastModified: Date;
}

export interface ObjectStorage {
  put(bucket: string, key: string, body: BodyInit, opts?: PutOptions): Promise<void>;
  /** The object, or null when it does not exist. With `range`, a 206 partial response. */
  get(bucket: string, key: string, opts?: GetOptions): Promise<Response | null>;
  head(bucket: string, key: string): Promise<ObjectInfo | null>;
  delete(bucket: string, key: string): Promise<void>;
  /**
   * Server-side copy within a bucket (S3 CopyObject): the bytes never pass through this process.
   * The copy keeps the source's content type and cache-control (metadata directive `COPY`).
   */
  copy(bucket: string, fromKey: string, toKey: string): Promise<void>;
  /** Delete every object under a prefix; returns how many were deleted. */
  deletePrefix(bucket: string, prefix: string): Promise<number>;
  list(bucket: string, prefix: string): AsyncIterable<ObjectInfo>;
  /**
   * Presigned URL a browser can PUT to directly (uploads bypass our services). The content type
   * and exact length are signed, so the upload must send those headers with those values.
   */
  presignPut(
    bucket: string,
    key: string,
    opts: { expiresSeconds: number; contentType: string; contentLength: number },
  ): Promise<string>;
  presignGet(bucket: string, key: string, opts: { expiresSeconds: number; filename?: string }): Promise<string>;
  ensureBucket(bucket: string): Promise<void>;
}

export interface S3Options {
  endpoint: string;
  /** Endpoint browsers reach, if different (e.g. behind Caddy). Used for presigned URLs. */
  publicEndpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style (`endpoint/bucket/key`) is required by Garage and most self-hosted stores. */
  forcePathStyle: boolean;
  fetch?: typeof fetch;
}

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

function objectUrl(endpoint: string, bucket: string, key: string, pathStyle: boolean): URL {
  const base = new URL(endpoint);
  if (pathStyle) return new URL(`${base.origin}${base.pathname.replace(/\/$/, "")}/${bucket}/${encodeKey(key)}`);
  return new URL(`${base.protocol}//${bucket}.${base.host}${base.pathname.replace(/\/$/, "")}/${encodeKey(key)}`);
}

export class S3Error extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "S3Error";
  }
}

async function fail(res: Response, what: string): Promise<never> {
  const text = await res.text().catch(() => "");
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? `HTTP${res.status}`;
  throw new S3Error(res.status, code, `${what}: ${code}`);
}

export function createS3Storage(opts: S3Options): ObjectStorage {
  const doFetch = opts.fetch ?? fetch;
  const client = new AwsClient({
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    region: opts.region,
    service: "s3",
  });
  const url = (bucket: string, key: string, endpoint = opts.endpoint) =>
    objectUrl(endpoint, bucket, key, opts.forcePathStyle);
  const send = async (u: URL | string, init: RequestInit = {}) => doFetch(await client.sign(u.toString(), init));

  const storage: ObjectStorage = {
    async put(bucket, key, body, o = {}) {
      const headers: Record<string, string> = {};
      if (o.contentType) headers["content-type"] = o.contentType;
      if (o.cacheControl) headers["cache-control"] = o.cacheControl;
      const res = await send(url(bucket, key), { method: "PUT", body, headers });
      if (!res.ok) await fail(res, `put ${bucket}/${key}`);
      await res.body?.cancel();
    },
    async get(bucket, key, o = {}) {
      const res = await send(url(bucket, key), o.range ? { headers: { range: o.range } } : {});
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) await fail(res, `get ${bucket}/${key}`);
      return res;
    },
    async head(bucket, key) {
      const res = await send(url(bucket, key), { method: "HEAD" });
      if (res.status === 404) return null;
      if (!res.ok) await fail(res, `head ${bucket}/${key}`);
      return {
        key,
        size: Number(res.headers.get("content-length") ?? 0),
        etag: res.headers.get("etag") ?? "",
        lastModified: new Date(res.headers.get("last-modified") ?? 0),
      };
    },
    async delete(bucket, key) {
      const res = await send(url(bucket, key), { method: "DELETE" });
      if (!res.ok && res.status !== 404) await fail(res, `delete ${bucket}/${key}`);
      await res.body?.cancel();
    },
    async copy(bucket, fromKey, toKey) {
      const res = await send(url(bucket, toKey), {
        method: "PUT",
        headers: {
          "x-amz-copy-source": `/${bucket}/${encodeKey(fromKey)}`,
          "x-amz-metadata-directive": "COPY",
        },
      });
      if (!res.ok) await fail(res, `copy ${bucket}/${fromKey}`);
      // CopyObject can fail after sending 200: the error is then in the body.
      const text = await res.text().catch(() => "");
      if (/<Error>/.test(text)) {
        const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? "CopyFailed";
        throw new S3Error(res.status, code, `copy ${bucket}/${fromKey}: ${code}`);
      }
    },
    async deletePrefix(bucket, prefix) {
      let n = 0;
      for await (const obj of storage.list(bucket, prefix)) {
        await storage.delete(bucket, obj.key);
        n++;
      }
      return n;
    },
    async *list(bucket, prefix) {
      let token: string | undefined;
      do {
        const u = url(bucket, "");
        u.searchParams.set("list-type", "2");
        u.searchParams.set("prefix", prefix);
        if (token) u.searchParams.set("continuation-token", token);
        const res = await send(u);
        if (!res.ok) await fail(res, `list ${bucket}/${prefix}`);
        const xml = await res.text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const c = m[1]!;
          const tag = (t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(c)?.[1] ?? "";
          yield {
            key: decodeXml(tag("Key")),
            size: Number(tag("Size")),
            etag: tag("ETag").replace(/&quot;/g, '"'),
            lastModified: new Date(tag("LastModified")),
          };
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
          ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1]
          : undefined;
      } while (token);
    },
    async presignPut(bucket, key, o) {
      if (!Number.isSafeInteger(o.contentLength) || o.contentLength < 0)
        throw new RangeError("contentLength must be a non-negative integer");
      const u = url(bucket, key, opts.publicEndpoint ?? opts.endpoint);
      u.searchParams.set("X-Amz-Expires", String(o.expiresSeconds));
      const signed = await client.sign(u.toString(), {
        method: "PUT",
        headers: { "content-type": o.contentType, "content-length": String(o.contentLength) },
        // aws4fetch leaves content-type and content-length unsigned unless told to sign every header.
        aws: { signQuery: true, allHeaders: true },
      });
      return signed.url;
    },
    async presignGet(bucket, key, o) {
      const u = url(bucket, key, opts.publicEndpoint ?? opts.endpoint);
      u.searchParams.set("X-Amz-Expires", String(o.expiresSeconds));
      if (o.filename)
        u.searchParams.set(
          "response-content-disposition",
          `attachment; filename="${o.filename.replace(/["\\\r\n]/g, "_")}"`,
        );
      const signed = await client.sign(u.toString(), { method: "GET", aws: { signQuery: true } });
      return signed.url;
    },
    async ensureBucket(bucket) {
      const head = await send(url(bucket, ""), { method: "HEAD" });
      if (head.ok) return;
      const res = await send(url(bucket, ""), { method: "PUT" });
      if (!res.ok && res.status !== 409) await fail(res, `create bucket ${bucket}`);
      await res.body?.cancel();
    },
  };
  return storage;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Build from the env schema in @commonair/config (storageEnv). */
export function storageFromEnv(env: {
  S3_ENDPOINT: string;
  S3_PUBLIC_ENDPOINT?: string | undefined;
  S3_REGION: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_FORCE_PATH_STYLE: boolean;
}): ObjectStorage {
  return createS3Storage({
    endpoint: env.S3_ENDPOINT,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
}

export { CopyVerificationError, moveVodObjects, type MoveResult } from "./move.ts";
