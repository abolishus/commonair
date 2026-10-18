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
 *
 * An existing key with a different secret is a hard error: Garage never lets a deleted
 * key id be reused, so rotation is an operator action (see infra/README.md).
 */

export interface GarageBootstrapOptions {
  adminUrl: string;
  adminToken: string;
  accessKeyId: string;
  secretAccessKey: string;
  keyName: string;
  buckets: string[];
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
interface BucketInfo {
  id: string;
  keys: { accessKeyId: string; permissions: { read: boolean; write: boolean; owner: boolean } }[];
}

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
    allow: (bucketId: string, accessKeyId: string) =>
      call<BucketInfo>("POST", "AllowBucketKey", {
        bucketId,
        accessKeyId,
        permissions: { read: true, write: true, owner: true },
      }),
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
  for (const b of opts.buckets) validateBucketName(b);
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const admin = createAdminClient(opts);
  const retryOpts = { timeoutMs: opts.timeoutMs, sleep, log };
  const result: BootstrapResult = { layoutApplied: false, keyImported: false, bucketsCreated: [] };

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

  const existing = await admin.keyInfo(opts.accessKeyId);
  if (!existing) {
    await admin.importKey(opts.accessKeyId, opts.secretAccessKey, opts.keyName);
    result.keyImported = true;
    log(`imported key ${opts.accessKeyId}`);
  } else if (existing.secretAccessKey !== undefined && existing.secretAccessKey !== opts.secretAccessKey) {
    throw new Error(
      `key ${opts.accessKeyId} already exists in Garage with a different secret; rotate it by hand (infra/README.md)`,
    );
  }

  for (const alias of opts.buckets) {
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
    const granted = bucket.keys?.some(
      (k) => k.accessKeyId === opts.accessKeyId && k.permissions.read && k.permissions.write && k.permissions.owner,
    );
    if (!granted) await admin.allow(bucket.id, opts.accessKeyId);
  }
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
    zone: env.GARAGE_ZONE || "dc1",
    capacityBytes: positive("GARAGE_CAPACITY_BYTES", 100_000_000_000),
    timeoutMs: positive("GARAGE_INIT_TIMEOUT_MS", 120_000),
  };
}

if (import.meta.main) {
  try {
    const opts = optionsFromEnv(process.env);
    const r = await bootstrapGarage({ ...opts, log: (m) => console.warn(`garage-init: ${m}`) });
    console.warn(
      `garage-init: done (layout ${r.layoutApplied ? "applied" : "unchanged"}, key ${r.keyImported ? "imported" : "present"}, ` +
        `buckets created: ${r.bucketsCreated.join(", ") || "none"})`,
    );
  } catch (e) {
    console.error(`garage-init: ${(e as Error).message}`);
    process.exit(1);
  }
}
