// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One-shot Garage bootstrap (the compose `garage-init` job). Idempotent; safe to re-run:
 *
 *   1. wait for the admin API (v2)
 *   2. assign and apply a single-node layout if the node has no role yet
 *   3. wait until the cluster reports healthy
 *   4. import the S3 key pair from S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
 *   5. create the media, exports and backups buckets and grant the key read/write/owner
 *   6. import the evidence key, create the evidence bucket, grant the evidence key read/write
 *      (not owner) on it alone, and make sure the main key has no permission there at all
 *      (ADR 0006 Q4: the API and media hold the main key and must not even list evidence)
 *
 *   7. with GARAGE_CORS_ORIGINS (compose only), a CORS rule on the media bucket (cors.ts)
 *
 * An existing key with a different secret is a hard error: Garage never lets a deleted
 * key id be reused, so rotation is an operator action (see infra/README.md).
 */

import { corsFromEnv, putBucketCors } from "./cors.ts";

export interface GarageBootstrapOptions {
  adminUrl: string;
  adminToken: string;
  accessKeyId: string;
  secretAccessKey: string;
  keyName: string;
  buckets: string[];
  /** The sealed-evidence bucket and the worker's own key for it. */
  evidence: { accessKeyId: string; secretAccessKey: string; keyName: string; bucket: string };
  zone: string;
  capacityBytes: number;
  /** How long to wait for the admin API and for cluster health. */
  timeoutMs: number;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface BootstrapResult {
  layoutApplied: boolean;
  keyImported: boolean;
  bucketsCreated: string[];
  evidenceKeyImported: boolean;
  /** Grants removed because they would let the wrong key reach the wrong bucket. */
  revoked: string[];
}

export class GarageError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GarageError";
  }
}

const ACCESS_KEY_RE = /^GK[0-9a-f]{24}$/;
const SECRET_KEY_RE = /^[0-9a-f]{64}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** Garage only accepts imported keys in its own format; fail before talking to it. */
export function validateKeyPair(accessKeyId: string, secretAccessKey: string): void {
  if (!ACCESS_KEY_RE.test(accessKeyId))
    throw new Error("S3_ACCESS_KEY_ID must be 'GK' followed by 24 lowercase hex characters (Garage key format)");
  if (!SECRET_KEY_RE.test(secretAccessKey))
    throw new Error("S3_SECRET_ACCESS_KEY must be 64 lowercase hex characters (Garage key format)");
}

export function validateBucketName(name: string): void {
  if (!BUCKET_RE.test(name) || name.includes("..")) throw new Error(`invalid bucket name: ${name}`);
}

interface ClusterNode {
  id: string;
  isUp: boolean;
  role: unknown;
}
interface ClusterStatus {
  layoutVersion: number;
  nodes: ClusterNode[];
}
interface LayoutRole {
  id: string;
}
interface ClusterLayout {
  version: number;
  roles: LayoutRole[];
  stagedRoleChanges: LayoutRole[];
}
interface KeyInfo {
  accessKeyId: string;
  secretAccessKey?: string;
}
interface Permissions {
  read: boolean;
  write: boolean;
  owner: boolean;
}
interface BucketInfo {
  id: string;
  keys: { accessKeyId: string; permissions: Permissions }[];
}
const FULL: Permissions = { read: true, write: true, owner: true };
const EVIDENCE: Permissions = { read: true, write: true, owner: false };
const DENY_ALL: Permissions = { read: true, write: true, owner: true };

export function createAdminClient(opts: Pick<GarageBootstrapOptions, "adminUrl" | "adminToken" | "fetch">) {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.adminUrl.replace(/\/+$/, "");
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}/v2/${path}`, {
      method,
      headers: { authorization: `Bearer ${opts.adminToken}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let code = `HTTP${res.status}`;
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { code?: string; message?: string };
        code = parsed.code ?? code;
        message = parsed.message ?? message;
      } catch {
        // non-JSON error body (e.g. a proxy); keep the raw text
      }
      throw new GarageError(res.status, code, `${method} ${path}: ${code}: ${message}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
  return {
    status: () => call<ClusterStatus>("GET", "GetClusterStatus"),
    health: () => call<{ status: string }>("GET", "GetClusterHealth"),
    layout: () => call<ClusterLayout>("GET", "GetClusterLayout"),
    stageRole: (id: string, zone: string, capacity: number) =>
      call<ClusterLayout>("POST", "UpdateClusterLayout", { roles: [{ id, zone, capacity, tags: ["commonair"] }] }),
    applyLayout: (version: number) => call<unknown>("POST", "ApplyClusterLayout", { version }),
    keyInfo: (id: string) =>
      call<KeyInfo>("GET", `GetKeyInfo?id=${encodeURIComponent(id)}&showSecretKey=true`).catch(notFoundAsNull),
    importKey: (accessKeyId: string, secretAccessKey: string, name: string) =>
      call<KeyInfo>("POST", "ImportKey", { accessKeyId, secretAccessKey, name }),
    bucketInfo: (alias: string) =>
      call<BucketInfo>("GET", `GetBucketInfo?globalAlias=${encodeURIComponent(alias)}`).catch(notFoundAsNull),
    createBucket: (alias: string) => call<BucketInfo>("POST", "CreateBucket", { globalAlias: alias }),
    allow: (bucketId: string, accessKeyId: string, permissions: Permissions = FULL) =>
      call<BucketInfo>("POST", "AllowBucketKey", { bucketId, accessKeyId, permissions }),
    /** Garage's DenyBucketKey removes every permission flagged `true` in the body. */
    deny: (bucketId: string, accessKeyId: string, permissions: Permissions) =>
      call<BucketInfo>("POST", "DenyBucketKey", { bucketId, accessKeyId, permissions }),
  };
}

function notFoundAsNull(e: unknown): null {
  if (e instanceof GarageError && e.status === 404) return null;
  throw e;
}

async function retry<T>(
  what: string,
  fn: () => Promise<T>,
  opts: { timeoutMs: number; sleep: (ms: number) => Promise<void>; log: (m: string) => void },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let delay = 250;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      // A wrong admin token never fixes itself; do not wait out the timeout.
      if (e instanceof GarageError && (e.status === 401 || e.status === 403)) throw e;
      if (Date.now() + delay > deadline) throw new Error(`${what}: gave up after ${opts.timeoutMs} ms: ${String(e)}`);
      opts.log(`${what}: not yet (${(e as Error).message}); retrying in ${delay} ms`);
      await opts.sleep(delay);
      delay = Math.min(delay * 2, 5000);
    }
  }
}

export async function bootstrapGarage(opts: GarageBootstrapOptions): Promise<BootstrapResult> {
  validateKeyPair(opts.accessKeyId, opts.secretAccessKey);
  const ev = opts.evidence;
  validateKeyPair(ev.accessKeyId, ev.secretAccessKey);
  if (ev.accessKeyId === opts.accessKeyId) throw new Error("the evidence key must differ from the main S3 key");
  for (const b of opts.buckets) validateBucketName(b);
  validateBucketName(ev.bucket);
  if (opts.buckets.includes(ev.bucket)) throw new Error("the evidence bucket must be its own bucket");
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const admin = createAdminClient(opts);
  const retryOpts = { timeoutMs: opts.timeoutMs, sleep, log };
  const result: BootstrapResult = {
    layoutApplied: false,
    keyImported: false,
    bucketsCreated: [],
    evidenceKeyImported: false,
    revoked: [],
  };

  const status = await retry("admin API", () => admin.status(), retryOpts);
  const layout = await admin.layout();
  if (layout.roles.length === 0) {
    const node = status.nodes.find((n) => n.isUp) ?? status.nodes[0];
    if (!node) throw new Error("Garage reports no nodes");
    if (!layout.stagedRoleChanges.some((r) => r.id === node.id))
      await admin.stageRole(node.id, opts.zone, opts.capacityBytes);
    await admin.applyLayout(layout.version + 1);
    result.layoutApplied = true;
    log(`layout v${layout.version + 1} applied for node ${node.id.slice(0, 16)}`);
  }

  await retry(
    "cluster health",
    async () => {
      const h = await admin.health();
      if (h.status !== "healthy") throw new Error(`cluster ${h.status}`);
    },
    retryOpts,
  );

  const importKey = async (accessKeyId: string, secretAccessKey: string, name: string): Promise<boolean> => {
    const existing = await admin.keyInfo(accessKeyId);
    if (!existing) {
      await admin.importKey(accessKeyId, secretAccessKey, name);
      log(`imported key ${accessKeyId}`);
      return true;
    }
    if (existing.secretAccessKey !== undefined && existing.secretAccessKey !== secretAccessKey)
      throw new Error(
        `key ${accessKeyId} already exists in Garage with a different secret; rotate it by hand (infra/README.md)`,
      );
    return false;
  };
  const ensureBucket = async (alias: string): Promise<BucketInfo> => {
    let bucket = await admin.bucketInfo(alias);
    if (!bucket) {
      try {
        bucket = await admin.createBucket(alias);
        result.bucketsCreated.push(alias);
        log(`created bucket ${alias}`);
      } catch (e) {
        // Another bootstrap run won the race; use its bucket.
        if (!(e instanceof GarageError && e.status === 409)) throw e;
        bucket = await admin.bucketInfo(alias);
        if (!bucket) throw e;
      }
    }
    return bucket;
  };
  const grantOf = (bucket: BucketInfo, key: string) => bucket.keys?.find((k) => k.accessKeyId === key)?.permissions;
  const revokeAll = async (bucket: BucketInfo, alias: string, key: string) => {
    const p = grantOf(bucket, key);
    if (p && (p.read || p.write || p.owner)) {
      await admin.deny(bucket.id, key, DENY_ALL);
      result.revoked.push(`${key}@${alias}`);
      log(`revoked ${key} on ${alias}`);
    }
  };

  result.keyImported = await importKey(opts.accessKeyId, opts.secretAccessKey, opts.keyName);
  for (const alias of opts.buckets) {
    const bucket = await ensureBucket(alias);
    const p = grantOf(bucket, opts.accessKeyId);
    if (!(p?.read && p.write && p.owner)) await admin.allow(bucket.id, opts.accessKeyId);
    await revokeAll(bucket, alias, ev.accessKeyId);
  }

  result.evidenceKeyImported = await importKey(ev.accessKeyId, ev.secretAccessKey, ev.keyName);
  const evidence = await ensureBucket(ev.bucket);
  await revokeAll(evidence, ev.bucket, opts.accessKeyId);
  const p = grantOf(evidence, ev.accessKeyId);
  if (p?.owner) {
    // Owner could re-grant other keys; the evidence key gets read and write only.
    await admin.deny(evidence.id, ev.accessKeyId, { read: false, write: false, owner: true });
    result.revoked.push(`${ev.accessKeyId}@${ev.bucket}:owner`);
  }
  if (!(p?.read && p.write)) await admin.allow(evidence.id, ev.accessKeyId, EVIDENCE);
  return result;
}

/** Build options from the environment the compose job receives. */
export function optionsFromEnv(env: Record<string, string | undefined>): GarageBootstrapOptions {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  const positive = (k: string, fallback: number) => {
    const n = Number(env[k] || fallback);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${k} must be a positive integer`);
    return n;
  };
  return {
    adminUrl: env.GARAGE_ADMIN_URL || "http://garage:3903",
    adminToken: need("GARAGE_ADMIN_TOKEN"),
    accessKeyId: need("S3_ACCESS_KEY_ID"),
    secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
    keyName: env.GARAGE_KEY_NAME || "commonair",
    buckets: [
      env.S3_BUCKET_MEDIA || "commonair-media",
      env.S3_BUCKET_EXPORTS || "commonair-exports",
      env.S3_BUCKET_BACKUPS || "commonair-backups",
    ],
    evidence: {
      accessKeyId: need("S3_EVIDENCE_ACCESS_KEY_ID"),
      secretAccessKey: need("S3_EVIDENCE_SECRET_ACCESS_KEY"),
      keyName: env.GARAGE_EVIDENCE_KEY_NAME || "commonair-evidence",
      bucket: env.S3_BUCKET_EVIDENCE || "commonair-evidence",
    },
    zone: env.GARAGE_ZONE || "dc1",
    capacityBytes: positive("GARAGE_CAPACITY_BYTES", 100_000_000_000),
    timeoutMs: positive("GARAGE_INIT_TIMEOUT_MS", 120_000),
  };
}

if (import.meta.main) {
  try {
    const opts = optionsFromEnv(process.env);
    const r = await bootstrapGarage({ ...opts, log: (m) => console.warn(`garage-init: ${m}`) });
    const cors = corsFromEnv(process.env);
    if (cors) {
      await putBucketCors(cors);
      console.warn(`garage-init: CORS on ${cors.bucket} for ${cors.origins.join(", ")}`);
    }
    console.warn(
      `garage-init: done (layout ${r.layoutApplied ? "applied" : "unchanged"}, key ${r.keyImported ? "imported" : "present"}, ` +
        `buckets created: ${r.bucketsCreated.join(", ") || "none"}, evidence key ${r.evidenceKeyImported ? "imported" : "present"}, ` +
        `revoked: ${r.revoked.join(", ") || "none"})`,
    );
  } catch (e) {
    console.error(`garage-init: ${(e as Error).message}`);
    process.exit(1);
  }
}
