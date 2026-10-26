// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Self-host e2e checks for an external object store (R0-b), as functions R0-e wires into
 * scripts/selfhost/e2e.ts with its helpers:
 *
 *   externalStoreSetup(inHost, expectThat)  a second Garage in its own rootful container on the
 *       e2e host, outside the instance's network and user, publishing its S3 port on every host
 *       address; its four buckets, the instance's two keys (the main one on media, exports and
 *       backups, the evidence one on evidence alone) and CORS on the media bucket.
 *   externalInstallFlags() / externalInstallEnv()  what to add to `selfhost.sh install`: the
 *       --s3-* flags, and the keys, which go in the environment, never on the command line.
 *   checkExternalStore(inHost, expectThat)  after such an install: no Garage unit or container,
 *       storage-init active, an avatar-sized upload through a presigned URL to the store itself
 *       (with the CORS preflight a browser sends), a presigned export download, and `status`
 *       naming the store with every bucket ok and no key in its output.
 *
 * The instance reaches the store at host.containers.internal (Podman's name for the host inside a
 * container), the "browser" (curl on the host) at 127.0.0.1: two endpoints, as S3_ENDPOINT and
 * S3_PUBLIC_ENDPOINT allow. Plain http, hence --s3-allow-http. Needs Podman on the host (the
 * first install puts it there) and network access for the pinned Garage image. An instance
 * never switches store, so this runs on a fresh host or after the Garage instance is removed.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./bundle.ts";

export type InHost = (
  script: string,
  opts?: { user?: boolean; env?: Record<string, string>; allowFail?: boolean },
) => string;
export type Expect = (ok: boolean, what: string) => void;

/** The second store: container, ports, region and bucket names (not the defaults, on purpose). */
export const E2E_STORE = {
  container: "commonair-e2e-s3",
  dir: "/root/commonair-e2e-s3",
  s3Port: 3910,
  region: "garage",
  /** How the instance's containers reach it. */
  endpoint: "http://host.containers.internal:3910",
  /** How a browser on the host reaches it. */
  publicEndpoint: "http://127.0.0.1:3910",
  buckets: { media: "e2e-media", exports: "e2e-exports", backups: "e2e-backups", evidence: "e2e-evidence" },
} as const;

/** The pinned Garage image, as the instance's own unit pins it. */
export const GARAGE_IMAGE = /^Image=(.*)$/m.exec(
  readFileSync(join(REPO_ROOT, "infra/quadlet/commonair-garage.container"), "utf8"),
)![1]!;

const hex = (n: number) => randomBytes(n).toString("hex");
/** Throwaway keys in Garage's format, fresh for each run of the e2e. */
export const E2E_KEYS = {
  S3_ACCESS_KEY_ID: `GK${hex(12)}`,
  S3_SECRET_ACCESS_KEY: hex(32),
  S3_EVIDENCE_ACCESS_KEY_ID: `GK${hex(12)}`,
  S3_EVIDENCE_SECRET_ACCESS_KEY: hex(32),
};
const RPC_SECRET = hex(32);
const ADMIN_TOKEN = hex(32);

/** The store's garage.toml: the instance's own settings, its secrets from the environment. */
export function garageToml(): string {
  return [
    'metadata_dir = "/var/lib/garage/meta"',
    'data_dir = "/var/lib/garage/data"',
    'db_engine = "lmdb"',
    "replication_factor = 1",
    'rpc_bind_addr = "0.0.0.0:3901"',
    'rpc_public_addr = "127.0.0.1:3901"',
    "[s3_api]",
    `s3_region = "${E2E_STORE.region}"`,
    'api_bind_addr = "0.0.0.0:3900"',
    'root_domain = ".s3.garage.localhost"',
    "[admin]",
    'api_bind_addr = "0.0.0.0:3903"',
    "",
  ].join("\n");
}

/** CORS for the media bucket: presigned PUTs from the instance's origin, as a browser sends them. */
export function corsXml(origin: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration><CORSRule>' +
    `<AllowedOrigin>${origin}</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod>` +
    "<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds>" +
    "</CORSRule></CORSConfiguration>"
  );
}

/** The flags for `selfhost.sh install` against the second store. */
export function externalInstallFlags(): string {
  const b = E2E_STORE.buckets;
  return [
    `--s3-endpoint ${E2E_STORE.endpoint}`,
    `--s3-public-endpoint ${E2E_STORE.publicEndpoint}`,
    `--s3-region ${E2E_STORE.region}`,
    "--s3-path-style true",
    "--s3-allow-http",
    `--s3-bucket-media ${b.media}`,
    `--s3-bucket-exports ${b.exports}`,
    `--s3-bucket-backups ${b.backups}`,
    `--s3-bucket-evidence ${b.evidence}`,
  ].join(" ");
}

/** The keys, for the install's environment (`inHost(…, { env })`). */
export const externalInstallEnv = (): Record<string, string> => ({ ...E2E_KEYS });

/** The shell script that starts and bootstraps the store; runs as root on the e2e host. */
export function setupScript(instanceOrigin: string): string {
  const s = E2E_STORE;
  const g = `podman exec ${s.container} /garage`;
  const allow = (bucket: string, key: string) => `${g} bucket allow --read --write --owner ${bucket} --key ${key}`;
  return [
    "set -eu",
    "command -v podman >/dev/null || { echo 'podman is not installed on the host yet' >&2; exit 1; }",
    `mkdir -p ${s.dir}`,
    `cat > ${s.dir}/garage.toml <<'EOF'\n${garageToml()}EOF`,
    `cat > ${s.dir}/cors.xml <<'EOF'\n${corsXml(instanceOrigin)}\nEOF`,
    `podman rm -f ${s.container} >/dev/null 2>&1 || true`,
    // Rootful, on Podman's default network: outside the instance user's containers and network.
    `podman run -d --name ${s.container} -p ${s.s3Port}:3900 ` +
      `-e GARAGE_RPC_SECRET -e GARAGE_ADMIN_TOKEN -v ${s.dir}/garage.toml:/etc/garage.toml:ro,Z ${GARAGE_IMAGE} >/dev/null`,
    `i=0; until ${g} status >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 60 ] || exit 1; sleep 1; done`,
    `node=$(${g} node id -q | cut -d@ -f1)`,
    `${g} layout assign -z dc1 -c 1G "$node" >/dev/null`,
    `${g} layout apply --version 1 >/dev/null`,
    `${g} key import --yes -n e2e-main "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null`,
    `${g} key import --yes -n e2e-evidence "$S3_EVIDENCE_ACCESS_KEY_ID" "$S3_EVIDENCE_SECRET_ACCESS_KEY" >/dev/null`,
    ...Object.values(s.buckets).map((b) => `${g} bucket create ${b} >/dev/null`),
    ...[s.buckets.media, s.buckets.exports, s.buckets.backups].map((b) => `${allow(b, "e2e-main")} >/dev/null`),
    `${allow(s.buckets.evidence, "e2e-evidence")} >/dev/null`,
    // PutBucketCors over the S3 API, signed by curl (SigV4).
    `curl -fsS --aws-sigv4 "aws:amz:${s.region}:s3" --user "$S3_ACCESS_KEY_ID:$S3_SECRET_ACCESS_KEY" ` +
      `-X PUT -H 'content-type: application/xml' --data-binary @${s.dir}/cors.xml ` +
      `'${s.publicEndpoint}/${s.buckets.media}?cors'`,
    "echo store-ready",
  ].join("\n");
}

/** Starts the second store and prepares it as an operator would (object-storage.md). */
export function externalStoreSetup(inHost: InHost, expectThat: Expect, instanceOrigin = "https://selfhost.test"): void {
  const out = inHost(setupScript(instanceOrigin), {
    env: { ...E2E_KEYS, GARAGE_RPC_SECRET: RPC_SECRET, GARAGE_ADMIN_TOKEN: ADMIN_TOKEN },
  });
  expectThat(out.trim().endsWith("store-ready"), "the external store is up with its buckets, keys and CORS");
  const unsigned = inHost(
    `curl -sS -o /dev/null -w '%{http_code}' '${E2E_STORE.publicEndpoint}/${E2E_STORE.buckets.media}/'`,
  ).trim();
  expectThat(unsigned === "403", `the external store refuses an unsigned listing (${unsigned})`);
}

/** JavaScript for `bun -e` in the api container: presign (and store an export), or verify. */
export function presignScript(run: string, op: "presign" | "verify", size: number): string {
  const c = JSON.stringify({
    op,
    uploadKey: `incoming/e2e/${run}.png`,
    exportKey: `e2e/${run}.zip`,
    exportBody: `commonair e2e external export ${run}`,
    size,
  });
  return `
const c = ${c};
const { storageFromEnv } = await import("/app/packages/storage/src/index.ts");
const env = process.env;
const s = storageFromEnv({
  S3_ENDPOINT: env.S3_ENDPOINT,
  S3_PUBLIC_ENDPOINT: env.S3_PUBLIC_ENDPOINT || undefined,
  S3_REGION: env.S3_REGION,
  S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
  S3_FORCE_PATH_STYLE: env.S3_FORCE_PATH_STYLE !== "false",
});
if (c.op === "presign") {
  await s.put(env.S3_BUCKET_EXPORTS, c.exportKey, c.exportBody, { contentType: "application/zip" });
  console.log(JSON.stringify({
    endpoint: env.S3_PUBLIC_ENDPOINT ?? "",
    upload: await s.presignPut(env.S3_BUCKET_MEDIA, c.uploadKey, { expiresSeconds: 600, contentType: "image/png", contentLength: c.size }),
    download: await s.presignGet(env.S3_BUCKET_EXPORTS, c.exportKey, { expiresSeconds: 600, filename: "e2e-export.zip" }),
    exportBody: c.exportBody,
  }));
} else {
  const res = await s.get(env.S3_BUCKET_MEDIA, c.uploadKey);
  const sha = res ? new Bun.CryptoHasher("sha256").update(await res.arrayBuffer()).digest("hex") : null;
  await s.delete(env.S3_BUCKET_MEDIA, c.uploadKey);
  await s.delete(env.S3_BUCKET_EXPORTS, c.exportKey);
  console.log(JSON.stringify({ sha }));
}
`;
}

function inApi<T>(inHost: InHost, script: string): T {
  const b64 = Buffer.from(script).toString("base64");
  const out = inHost(`podman exec -w /app/packages/storage commonair-api bun -e "$(printf %s ${b64} | base64 -d)"`, {
    user: true,
  });
  return JSON.parse(out.trim().split("\n").at(-1) ?? "null") as T;
}

/** An avatar's size: under the 10 MB upload limit, more than one network packet. */
export const AVATAR_BYTES = 256 * 1024;

/** The lines `status` must print for the store (each bucket ok, no warning). */
export function statusProblems(status: string): string[] {
  const problems: string[] = [];
  if (!status.includes(`storage:   external S3 at ${E2E_STORE.endpoint}`))
    problems.push("no 'storage: external S3' line");
  for (const [role, bucket] of Object.entries(E2E_STORE.buckets))
    if (!new RegExp(`^\\s+${role}\\s+${bucket}\\s+ok$`, "m").test(status)) problems.push(`${role} (${bucket}) not ok`);
  if (/NOT ready|FAILED|WARNING/.test(status)) problems.push("a failure or warning");
  for (const v of Object.values(E2E_KEYS)) if (status.includes(v)) problems.push("a key in the output");
  return problems;
}

/** After `selfhost.sh install … externalInstallFlags()`: the instance uses the external store. */
export function checkExternalStore(inHost: InHost, expectThat: Expect, instanceOrigin = "https://selfhost.test"): void {
  const quadlets = inHost("ls ~/.config/containers/systemd", { user: true });
  expectThat(!/commonair-garage(\.container|-data|-meta)/.test(quadlets), "no Garage unit or volume is installed");
  expectThat(/commonair-storage-init\.container/.test(quadlets), "commonair-storage-init is installed");
  const containers = inHost("podman ps -a --format '{{.Names}}'", { user: true });
  expectThat(!/^commonair-garage$/m.test(containers), "no commonair-garage container exists");
  const init = inHost("systemctl --user is-active commonair-storage-init.service", {
    user: true,
    allowFail: true,
  }).trim();
  expectThat(init === "active", `commonair-storage-init checked the store and is active (${init})`);

  // A presigned upload of an avatar-sized object, straight to the store, as the browser does it.
  const run = `ext-${Date.now()}`;
  const file = `/tmp/commonair-e2e-${run}.png`;
  const localSha = inHost(`head -c ${AVATAR_BYTES} /dev/urandom > ${file} && sha256sum ${file} | cut -d' ' -f1`, {
    user: true,
  }).trim();
  const p = inApi<{ endpoint: string; upload: string; download: string; exportBody: string }>(
    inHost,
    presignScript(run, "presign", AVATAR_BYTES),
  );
  expectThat(p.endpoint === E2E_STORE.publicEndpoint, `S3_PUBLIC_ENDPOINT is the store's (${p.endpoint})`);
  expectThat(
    p.upload.startsWith(`${E2E_STORE.publicEndpoint}/${E2E_STORE.buckets.media}/incoming/`),
    "the upload URL is on the store",
  );
  const preflight = inHost(
    `curl -sS -o /dev/null -D - -X OPTIONS -H 'Origin: ${instanceOrigin}' -H 'Access-Control-Request-Method: PUT' ` +
      `-H 'Access-Control-Request-Headers: content-type' '${p.upload}'`,
    { user: true },
  );
  expectThat(
    new RegExp(`^access-control-allow-origin: (\\*|${instanceOrigin.replaceAll(".", "\\.")})\\r?$`, "im").test(
      preflight,
    ),
    "the store answers the browser's CORS preflight for the upload",
  );
  const put = inHost(
    `curl -sS -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: image/png' --data-binary @${file} '${p.upload}'`,
    { user: true },
  ).trim();
  expectThat(put.startsWith("2"), `a presigned PUT of ${AVATAR_BYTES} bytes to the store answers ${put}`);

  // The export link, as a user's browser opens it.
  const got = inHost(`curl -sS -i '${p.download}'`, { user: true });
  const split = got.indexOf("\r\n\r\n");
  const status = /^HTTP\/\S+ (\d+)/.exec(got)?.[1] ?? "";
  expectThat(status === "200", `the presigned export download answers ${status || "nothing"}`);
  expectThat(got.slice(split + 4) === p.exportBody, "the export download returns the stored bytes");

  const { sha } = inApi<{ sha: string | null }>(inHost, presignScript(run, "verify", AVATAR_BYTES));
  expectThat(sha === localSha, "the uploaded object is in the media bucket, byte for byte");
  inHost(`rm -f ${file}`, { user: true, allowFail: true });

  const st = inHost("sh ~/commonair/selfhost.sh status", { user: true });
  const problems = statusProblems(st);
  expectThat(
    problems.length === 0,
    `status reports the external store and its buckets (${problems.join(", ") || "ok"})`,
  );
}

/** Removes the second store (cleanup; ignores a store that is not there). */
export function externalStoreTeardown(inHost: InHost): void {
  inHost(`podman rm -f ${E2E_STORE.container} >/dev/null 2>&1; rm -rf ${E2E_STORE.dir}`, { allowFail: true });
}
