// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one-shot every service of a self-hosted instance requires (commonair-storage-init): "object
 * storage is ready". Which store comes from S3_MODE, which selfhost.sh writes:
 *
 *   unset or `garage`  Garage on this host: the idempotent bootstrap of bootstrap.ts (layout,
 *                      key import, buckets and grants).
 *   `external`         the operator's S3-compatible store (selfhost.sh --s3-endpoint). Its
 *                      buckets are the operator's to create (docs/self-hosting/object-storage.md);
 *                      this checks with the instance's own keys that each exists and takes a
 *                      write, read and delete of a probe object, and exits non-zero naming what
 *                      is missing, so the services never start against a store they cannot use.
 *
 *   bun infra/garage/storage-init.ts            bootstrap or check (the unit's Exec=)
 *   bun infra/garage/storage-init.ts --check    external only, read only: list each bucket
 *                                               (selfhost.sh status); never prints a key
 */
import { S3Client } from "bun";
import { bootstrapGarage, optionsFromEnv, validateBucketName } from "./bootstrap.ts";

type Env = Record<string, string | undefined>;

export type StorageMode = "garage" | "external";

export function storageMode(env: Env): StorageMode {
  const mode = env.S3_MODE ?? "";
  if (mode === "" || mode === "garage") return "garage";
  if (mode === "external") return "external";
  throw new Error(`S3_MODE must be garage or external, not ${mode}`);
}

export interface S3Key {
  accessKeyId: string;
  secretAccessKey: string;
}

export const BUCKET_ROLES = ["media", "exports", "backups", "evidence"] as const;
export type BucketRole = (typeof BUCKET_ROLES)[number];

export interface ExternalStore {
  endpoint: string;
  region: string;
  pathStyle: boolean;
  buckets: Record<BucketRole, string>;
  /** S3_ACCESS_KEY_ID: media, exports and backups. */
  main: S3Key;
  /** S3_EVIDENCE_ACCESS_KEY_ID: the evidence bucket alone (ADR 0006 Q4). */
  evidence: S3Key;
  /**
   * False when WAL-G writes its backups elsewhere (the operator set AWS_ENDPOINT or
   * WALG_S3_PREFIX, ADR 0025): the backups bucket on this store is then not used.
   */
  checkBackups: boolean;
}

const BOOL: Record<string, boolean> = { true: true, "1": true, false: false, "0": false };

/** The external store from the environment the unit receives; throws on anything missing. */
export function storeFromEnv(env: Env): ExternalStore {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required with S3_MODE=external`);
    return v;
  };
  const endpoint = need("S3_ENDPOINT").replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`S3_ENDPOINT is not a URL: ${endpoint}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`S3_ENDPOINT must be an http(s) URL: ${endpoint}`);
  const pathStyleRaw = env.S3_FORCE_PATH_STYLE || "true";
  const pathStyle = BOOL[pathStyleRaw];
  if (pathStyle === undefined) throw new Error(`S3_FORCE_PATH_STYLE must be true or false, not ${pathStyleRaw}`);
  const buckets: Record<BucketRole, string> = {
    media: env.S3_BUCKET_MEDIA || "commonair-media",
    exports: env.S3_BUCKET_EXPORTS || "commonair-exports",
    backups: env.S3_BUCKET_BACKUPS || "commonair-backups",
    evidence: env.S3_BUCKET_EVIDENCE || "commonair-evidence",
  };
  for (const b of Object.values(buckets)) validateBucketName(b);
  if (new Set(Object.values(buckets)).size !== BUCKET_ROLES.length)
    throw new Error("the media, exports, backups and evidence buckets must be four different buckets");
  const main = { accessKeyId: need("S3_ACCESS_KEY_ID"), secretAccessKey: need("S3_SECRET_ACCESS_KEY") };
  const evidence = {
    accessKeyId: need("S3_EVIDENCE_ACCESS_KEY_ID"),
    secretAccessKey: need("S3_EVIDENCE_SECRET_ACCESS_KEY"),
  };
  if (evidence.accessKeyId === main.accessKeyId)
    throw new Error("the evidence key must differ from the main S3 key (ADR 0006 Q4)");
  return {
    endpoint,
    region: need("S3_REGION"),
    pathStyle,
    buckets,
    main,
    evidence,
    checkBackups: !env.AWS_ENDPOINT && !env.WALG_S3_PREFIX,
  };
}

/** What the check needs of one bucket, through one key. */
export interface BucketClient {
  write(key: string, body: string): Promise<unknown>;
  text(key: string): Promise<string>;
  delete(key: string): Promise<unknown>;
  /** A listing of at most one key: the read-only reachability check. */
  list(): Promise<unknown>;
}
export type ClientFor = (bucket: string, key: S3Key) => BucketClient;

/** Virtual-hosted style: `<scheme>://<bucket>.<host>`; Bun's client takes that as its endpoint. */
export function bucketEndpoint(endpoint: string, bucket: string, pathStyle: boolean): string {
  if (pathStyle) return endpoint;
  const u = new URL(endpoint);
  return `${u.protocol}//${bucket}.${u.host}`;
}

/** Bun's built-in S3 client (SigV4), so the tools image needs no S3 package. */
export function bunClients(store: Pick<ExternalStore, "endpoint" | "region" | "pathStyle">): ClientFor {
  return (bucket, key) => {
    const c = new S3Client({
      accessKeyId: key.accessKeyId,
      secretAccessKey: key.secretAccessKey,
      region: store.region,
      bucket,
      endpoint: bucketEndpoint(store.endpoint, bucket, store.pathStyle),
      virtualHostedStyle: !store.pathStyle,
    });
    return {
      write: (k, body) => c.write(k, body),
      text: (k) => c.file(k).text(),
      delete: (k) => c.delete(k),
      list: () => c.list({ maxKeys: 1 }),
    };
  };
}

/** An operator's reading of an S3 failure: what is wrong and what to change. */
export function explain(e: unknown, ctx: { bucket: string; keyName: string; endpoint: string }): string {
  const err = e as { code?: string; name?: string; message?: string };
  const code = err.code ?? "";
  const message = err.message ?? String(e);
  switch (code) {
    case "NoSuchBucket":
      return `bucket ${ctx.bucket} does not exist on ${ctx.endpoint}: create it (docs/self-hosting/object-storage.md)`;
    case "AccessDenied":
    case "AllAccessDisabled":
      return `${ctx.keyName} may not read, write and delete in ${ctx.bucket}: grant it those on that bucket`;
    case "InvalidAccessKeyId":
      return `the store does not know ${ctx.keyName}: check its value in commonair.env`;
    case "SignatureDoesNotMatch":
      return `the store rejects the signature of ${ctx.keyName}: check its secret and S3_REGION`;
    case "AuthorizationHeaderMalformed":
    case "PermanentRedirect":
    case "IllegalLocationConstraintException":
      return `${ctx.bucket} is not in region S3_REGION on ${ctx.endpoint} (${code}): set the bucket's region`;
    case "TimeoutError":
      return `${ctx.endpoint} did not answer in time`;
  }
  if (
    /ConnectionRefused|ECONNREFUSED|ENOTFOUND|FailedToOpenSocket|Unable to connect|fetch failed/i.test(message + code)
  )
    return `cannot reach ${ctx.endpoint}: ${message}`;
  return `${ctx.bucket}: ${code ? `${code}: ` : ""}${message}`;
}

export interface BucketReport {
  role: BucketRole;
  bucket: string;
  ok: boolean;
  /** Why not, when not ok; never a key. */
  problem?: string;
  /** Not checked, and why (backups elsewhere). */
  skipped?: string;
}

export interface StoreReport {
  ok: boolean;
  buckets: BucketReport[];
  warnings: string[];
}

export interface CheckOptions {
  /** true (storage-init): write, read back and delete a probe object. false (status): list only. */
  write: boolean;
  /** Per S3 call. */
  timeoutMs?: number;
  /** The probe object's key (tests fix it). */
  probeKey?: string;
}

/** Where the write check puts its probe object, deleted right after. */
export const PROBE_PREFIX = ".commonair-storage-check/";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`no answer in ${ms} ms`), { code: "TimeoutError" })), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Checks every bucket the instance uses with the key that uses it: the main key on media,
 * exports and backups, the evidence key on the evidence bucket. Also warns (it cannot be fixed
 * from here) when the main key can list the evidence bucket, which ADR 0006 Q4 rules out.
 */
export async function checkExternalStore(
  store: ExternalStore,
  clientFor: ClientFor,
  opts: CheckOptions,
): Promise<StoreReport> {
  const ms = opts.timeoutMs ?? 15_000;
  const probe = opts.probeKey ?? `${PROBE_PREFIX}${crypto.randomUUID()}`;
  const body = `commonair storage check ${probe}`;
  const report: StoreReport = { ok: true, buckets: [], warnings: [] };
  for (const role of BUCKET_ROLES) {
    const bucket = store.buckets[role];
    if (role === "backups" && !store.checkBackups) {
      report.buckets.push({ role, bucket, ok: true, skipped: "WAL-G writes to AWS_ENDPOINT or WALG_S3_PREFIX" });
      continue;
    }
    const keyName = role === "evidence" ? "S3_EVIDENCE_ACCESS_KEY_ID" : "S3_ACCESS_KEY_ID";
    const c = clientFor(bucket, role === "evidence" ? store.evidence : store.main);
    try {
      if (opts.write) {
        await withTimeout(c.write(probe, body), ms);
        const got = await withTimeout(c.text(probe), ms);
        if (got !== body) throw new Error(`reading the probe object back returned other bytes`);
        await withTimeout(c.delete(probe), ms);
      } else {
        await withTimeout(c.list(), ms);
      }
      report.buckets.push({ role, bucket, ok: true });
    } catch (e) {
      report.ok = false;
      report.buckets.push({
        role,
        bucket,
        ok: false,
        problem: explain(e, { bucket, keyName, endpoint: store.endpoint }),
      });
    }
  }
  try {
    await withTimeout(clientFor(store.buckets.evidence, store.main).list(), ms);
    report.warnings.push(
      `S3_ACCESS_KEY_ID can list the evidence bucket ${store.buckets.evidence}: give the services a key limited to ` +
        `${store.buckets.media}, ${store.buckets.exports} and ${store.buckets.backups} (ADR 0006 Q4)`,
    );
  } catch {
    // Refused (or unreachable, which the evidence check above already reports): as it should be.
  }
  return report;
}

/** One line per bucket, for the journal and `selfhost.sh status`. */
export function formatReport(report: StoreReport): string[] {
  const lines = report.buckets.map(
    (b) =>
      `${b.role.padEnd(9)} ${b.bucket.padEnd(28)} ${b.skipped ? `skipped (${b.skipped})` : b.ok ? "ok" : `FAILED: ${b.problem}`}`,
  );
  return [...lines, ...report.warnings.map((w) => `WARNING: ${w}`)];
}

const out = (line: string) => process.stdout.write(`${line}\n`);

/** The unit's (and status's) entry point; returns the exit code. */
export async function main(argv: string[], env: Env): Promise<number> {
  const check = argv.includes("--check");
  if (storageMode(env) === "garage") {
    if (check) {
      out("object storage: Garage on this host (commonair-garage)");
      return 0;
    }
    const r = await bootstrapGarage({ ...optionsFromEnv(env), log: (m) => console.warn(`storage-init: ${m}`) });
    console.warn(
      `storage-init: Garage ready (layout ${r.layoutApplied ? "applied" : "unchanged"}, key ${r.keyImported ? "imported" : "present"}, ` +
        `buckets created: ${r.bucketsCreated.join(", ") || "none"}, evidence key ${r.evidenceKeyImported ? "imported" : "present"}, ` +
        `revoked: ${r.revoked.join(", ") || "none"})`,
    );
    return 0;
  }
  const store = storeFromEnv(env);
  const report = await checkExternalStore(store, bunClients(store), { write: !check });
  const lines = formatReport(report);
  if (check) for (const l of lines) out(l);
  else for (const l of lines) console.warn(`storage-init: ${l}`);
  if (!report.ok) {
    console.error(
      `storage-init: the external store at ${store.endpoint} is not ready; fix the buckets above ` +
        "(docs/self-hosting/object-storage.md), then: systemctl --user restart commonair-storage-init",
    );
    return 1;
  }
  if (!check) console.warn(`storage-init: the external store at ${store.endpoint} is ready`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2), process.env));
  } catch (e) {
    console.error(`storage-init: ${(e as Error).message}`);
    process.exit(1);
  }
}
