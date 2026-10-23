// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Self-host end to end (ADR 0023 §7 and §9): what we test is what we ship.
 *
 *   bun scripts/selfhost/e2e.ts [--distro debian|fedora] [--keep]
 *
 * 1. Builds the 14 release images from this checkout (an image already built for this commit,
 *    by its label, is reused), pushes them to a throwaway Zot registry and writes a release
 *    manifest with the real digests, then the bundle with bundle.ts and its SHA256SUMS.
 * 2. Starts a privileged systemd container (Debian 13, or Fedora 42 with --distro fedora) like a
 *    fresh server, without Podman, and runs `selfhost.sh install --bundle … --tls internal --domain selfhost.test
 *    --registry <zot>` in it as root, which prepares the host and continues as the unprivileged
 *    `commonair` user.
 * 3. Checks https://selfhost.test/ and /api/status through Caddy's internal CA, and browser
 *    access to object storage (ADR 0024): a presigned PUT into the media bucket's incoming/ and
 *    a presigned export GET succeed through Caddy, and unsigned or out-of-scope requests do not.
 *    And that each container has only its keys of commonair.env: Caddy no database, session
 *    or S3 secret, the API its DATABASE_URL. Network exposure: Valkey refuses a client without
 *    its password; the API tells two source addresses on the host apart (its per-address auth
 *    rate limit, behind Caddy's socket-activated port) and ignores a client's X-Forwarded-For;
 *    HTTPS answers over IPv6 when the host has it; and `ss -ltne` shows only the allowlisted
 *    listeners.
 * 4. Builds release 0.0.0-e2e.2 (every image re-labelled, so every digest changes), upgrades,
 *    and checks from systemd's own invocation IDs and timestamps that the upgrade re-ran migrate
 *    and that it finished before api and worker started, and that `status` reports the new
 *    version, and repeats the object storage, Valkey and listener checks. Then kills the worker
 *    container and checks that systemd restarts it.
 * 5. Upgrades to a deliberately broken release (an api that never gets healthy) and checks
 *    that it rolls back to 0.0.0-e2e.2 and stays healthy.
 *
 * Needs podman 4.9 or newer on the outer host (CI: `sudo bun scripts/selfhost/e2e.ts` on
 * ubuntu-24.04, rootful Podman 4.9; locally: a podman machine that allows --privileged) and
 * network access for the base images and the third-party images the units pull. The outer
 * podman gets only flags Podman 4.9 has (build, push --digestfile, run --privileged
 * --systemd=always --add-host, network create, port, exec, rm -t); Podman 5 is needed only
 * inside the host container, where selfhost.sh installs its distribution's. The host container reaches the
 * registry by an --add-host entry with Zot's address, so it works on either network backend
 * (netavark, or CNI without the dnsname plugin). As root, Bun and podman must be on root's PATH. Logs go to .cache/selfhost-e2e/;
 * --keep leaves the containers running for debugging. Exits non-zero on failure.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_REGISTRY, RELEASE_IMAGES, type ReleaseImage, bundleAssetName } from "../release/manifest.ts";
import { REPO_ROOT, buildBundle } from "./bundle.ts";

// Test-only images (ADR 0022: digest-pinned, licensed in infra/image-licenses.json).
export const ZOT_IMAGE =
  "ghcr.io/project-zot/zot:v2.1.22@sha256:96cda11459ce6f8c60da3b03f03e9f67fd11b3ae2d82c4c04c92b3c608996080";
export const HOST_IMAGES = {
  debian:
    "docker.io/library/debian:trixie-20261005@sha256:913f6706df59a68922d1dd08f78c2476560a8d367897200a6005b00e5f67c2d5",
  fedora: "quay.io/fedora/fedora:42@sha256:e78cd1a688cd079c23864f289a89a49a3f4ad66d817864e325e1d058310ee95c",
} as const;
type Distro = keyof typeof HOST_IMAGES;

const PREFIX = "commonair-e2e";
const NETWORK = `${PREFIX}-net`;
const ZOT = `${PREFIX}-zot`;
const HOST = `${PREFIX}-host`;
const DOMAIN = "selfhost.test";
/** How the host container reaches the registry (plain HTTP, marked insecure in its registries.conf). */
const MIRROR = `${ZOT}:5000/commonair`;
const LOCAL = "localhost/commonair-e2e";
const REVISION_LABEL = "org.opencontainers.image.revision";
const MODEL_FILE = "adamcodd-vit-base-nsfw-detector-8587de99-int8.onnx";
const LOG_DIR = join(REPO_ROOT, ".cache/selfhost-e2e");
const LOG = join(LOG_DIR, "e2e.log");

// --- process helpers ----------------------------------------------------------------------

function log(line: string): void {
  appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
}

class StepError extends Error {}

/** Runs a command, logging it and its output; throws on a non-zero exit unless `allowFail`. */
function run(cmd: string[], opts: { input?: string; allowFail?: boolean; quiet?: boolean } = {}): string {
  log(`$ ${cmd.join(" ")}`);
  const r = Bun.spawnSync(cmd, {
    cwd: REPO_ROOT,
    stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = r.stdout.toString();
  const err = r.stderr.toString();
  if (!opts.quiet) appendFileSync(LOG, out + err);
  if (r.exitCode !== 0 && !opts.allowFail)
    throw new StepError(`${cmd.slice(0, 4).join(" ")} … exited ${r.exitCode}\n${err.slice(-2000)}`);
  return out;
}

const podman = (args: string[], opts?: Parameters<typeof run>[1]) => run(["podman", ...args], opts);

/** A shell command in the host container, as root or as the instance user with its session. */
function inHost(script: string, opts: { user?: boolean; env?: Record<string, string>; allowFail?: boolean } = {}) {
  const env = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  if (!opts.user) return podman(["exec", ...env, HOST, "sh", "-c", script], { allowFail: opts.allowFail });
  const uid = podman(["exec", HOST, "id", "-u", "commonair"]).trim();
  return podman(
    [
      "exec",
      "-u",
      "commonair",
      "-w",
      "/home/commonair",
      "-e",
      "HOME=/home/commonair",
      "-e",
      `XDG_RUNTIME_DIR=/run/user/${uid}`,
      "-e",
      `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`,
      ...env,
      HOST,
      "sh",
      "-c",
      script,
    ],
    { allowFail: opts.allowFail },
  );
}

const timings: [string, number][] = [];
async function step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const start = performance.now();
  console.log(`▶ ${name}`);
  log(`== ${name}`);
  try {
    return await fn();
  } finally {
    const s = (performance.now() - start) / 1000;
    timings.push([name, s]);
    console.log(`  ${s.toFixed(1)} s`);
  }
}

function expectThat(ok: boolean, what: string): void {
  log(`${ok ? "ok" : "FAIL"}: ${what}`);
  if (!ok) throw new StepError(what);
}

// --- images -------------------------------------------------------------------------------

interface BuildSpec {
  file: string;
  context: string;
  args: Record<string, string>;
}

/** How compose builds each release image (compose.yaml is the source of truth). */
export function buildSpecs(): Record<ReleaseImage, BuildSpec> {
  const compose = Bun.YAML.parse(readFileSync(join(REPO_ROOT, "compose.yaml"), "utf8")) as {
    services: Record<
      string,
      { image?: string; build?: { context?: string; dockerfile?: string; args?: Record<string, string> } }
    >;
  };
  const specs: Partial<Record<ReleaseImage, BuildSpec>> = {};
  for (const service of Object.values(compose.services)) {
    const name = /\/([a-z-]+):\$\{IMAGE_TAG/.exec(service.image ?? "")?.[1];
    if (!name || !service.build || !(RELEASE_IMAGES as readonly string[]).includes(name)) continue;
    specs[name as ReleaseImage] = {
      file: service.build.dockerfile ?? "Containerfile",
      context: service.build.context ?? ".",
      args: service.build.args ?? {},
    };
  }
  specs.relay = { file: "relay/Containerfile", context: "relay", args: {} };
  const missing = RELEASE_IMAGES.filter((n) => !specs[n]);
  if (missing.length) throw new Error(`no build for ${missing.join(", ")} in compose.yaml`);
  return specs as Record<ReleaseImage, BuildSpec>;
}

/**
 * Podman 4.9 (CI's runner) sometimes loses an intermediate image of its build cache: the cache
 * lookup fails right after pulling a base ("checking if cached image exists from a previous build:
 * getting top layer info: layer not known"), or a step reuses a cached image that is gone a moment
 * later ("creating build container: <id>: image not known"). The same build passes when run
 * again. Nothing else is retried.
 */
export function isTransientBuildError(message: string): boolean {
  return (
    /checking if cached image exists from a previous build: .*layer not known/.test(message) ||
    /creating build container: [0-9a-f]{12,64}: image not known/.test(message)
  );
}

/**
 * The retry of a build that hit a lost cache entry. Without the cache: the broken entry stays
 * in storage, and a plain retry looked it up and failed the same way (CI, Debian e2e). Pure.
 */
export function buildRetryArgs(args: readonly string[]): string[] {
  return ["build", "--no-cache", ...args];
}

/**
 * Every image the e2e builds goes through here (a test checks that no other `podman build`
 * exists): the host image's build hit the same lost cache entry on CI (run 39988149327) when it
 * was the only one that did not. Each build retries once on its own; later builds keep the cache,
 * since rebuilding the shared Bun stages for every image costs minutes and gigabytes.
 */
function build(args: string[]): void {
  try {
    podman(["build", ...args]);
  } catch (e) {
    if (!(e instanceof StepError) || !isTransientBuildError(e.message)) throw e;
    log(`podman build hit a lost build-cache entry; retrying once without the cache`);
    podman(buildRetryArgs(args));
  }
}

function buildImages(commit: string): void {
  const specs = buildSpecs();
  for (const name of RELEASE_IMAGES) {
    const tag = `${LOCAL}/${name}:${commit.slice(0, 12)}`;
    const label = podman(["image", "inspect", "--format", `{{index .Labels "${REVISION_LABEL}"}}`, tag], {
      allowFail: true,
      quiet: true,
    }).trim();
    if (label === commit) {
      log(`reuse ${tag}`);
      continue;
    }
    const { file, context, args } = specs[name];
    const buildArgs = Object.entries({ ...args, SOURCE_COMMIT: commit }).flatMap(([k, v]) => [
      "--build-arg",
      `${k}=${v}`,
    ]);
    build(["-f", file, ...buildArgs, "--label", `${REVISION_LABEL}=${commit}`, "-t", tag, context]);
  }
}

/** Re-labels every image of `fromTag` so each digest changes (a new release of the same code). */
function relabel(commit: string, release: string, broken: ReleaseImage[] = []): void {
  for (const name of RELEASE_IMAGES) {
    const from = `${LOCAL}/${name}:${commit.slice(0, 12)}`;
    const lines = [`FROM ${from}`, `LABEL ${RELEASE_LABEL}="${release}"`];
    // An api that runs but never answers its health check.
    if (broken.includes(name)) lines.push('ENTRYPOINT ["sleep", "infinity"]');
    const dir = join(LOG_DIR, "relabel", `${release}-${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Containerfile"), `${lines.join("\n")}\n`);
    build(["-t", `${LOCAL}/${name}:${release}`, dir]);
  }
}

/** Pushes the images for `release` to Zot and returns their digests. */
function push(
  release: string,
  sourceTag: (name: ReleaseImage) => string,
  port: string,
): Record<string, { digest: string }> {
  const images: Record<string, { digest: string }> = {};
  for (const name of RELEASE_IMAGES) {
    const digestFile = join(LOG_DIR, `digest-${release}-${name}`);
    podman([
      "push",
      "--tls-verify=false",
      "--digestfile",
      digestFile,
      sourceTag(name),
      `localhost:${port}/commonair/${name}:${release}`,
    ]);
    images[name] = { digest: readFileSync(digestFile, "utf8").trim() };
  }
  return images;
}

/** Manifest, bundle and SHA256SUMS for one release, in a directory the host container mounts. */
async function release(version: string, commit: string, images: Record<string, { digest: string }>): Promise<string> {
  const manifestJson = JSON.stringify(
    {
      schema: 1,
      version,
      tag: `v${version}`,
      commit,
      // As published; the host pulls from the mirror (--registry), which keeps the digests.
      registry: DEFAULT_REGISTRY,
      images,
      platforms: [process.arch === "arm64" ? "linux/arm64" : "linux/amd64"],
    },
    null,
    2,
  );
  const dir = join(LOG_DIR, "releases", version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "release-manifest.json"), manifestJson);
  const { name, data } = await buildBundle({ manifestJson });
  writeFileSync(join(dir, name), data);
  writeFileSync(join(dir, "SHA256SUMS"), `${createHash("sha256").update(data).digest("hex")}  ${name}\n`);
  return dir;
}

// --- host container -----------------------------------------------------------------------

export function hostContainerfile(distro: Distro): string {
  // What a fresh cloud server has: systemd and a few basics, but no Podman. selfhost.sh installs
  // Podman and its helpers itself, as root, which is the path an operator takes.
  const install =
    distro === "debian"
      ? "RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends " +
        "systemd systemd-sysv dbus curl ca-certificates iproute2 procps && rm -rf /var/lib/apt/lists/*"
      : "RUN dnf install -y systemd curl iproute procps-ng util-linux shadow-utils && dnf clean all && " +
        // The container image ships newuidmap/newgidmap without the file capabilities a real
        // Fedora install has (rpm -V: P), so rootless Podman cannot map its user namespace.
        "dnf reinstall -y shadow-utils && dnf clean all";
  return [
    `FROM ${HOST_IMAGES[distro]}`,
    install,
    // A real server reaches network-online.target at boot (ifupdown, networkd, NetworkManager);
    // a container has nothing that does, and Podman's user units then wait 90 s for it on every
    // start. This stands in for the distribution's wait-online service.
    "RUN printf '[Unit]\\nDescription=e2e: the container network is up\\nBefore=network-online.target\\n" +
      "[Service]\\nType=oneshot\\nRemainAfterExit=yes\\nExecStart=/bin/true\\n" +
      "[Install]\\nWantedBy=network-online.target\\n' > /etc/systemd/system/e2e-online.service && " +
      "systemctl enable e2e-online.service && systemctl add-wants multi-user.target network-online.target",
    // The throwaway registry speaks plain HTTP on the test network.
    `RUN mkdir -p /etc/containers/registries.conf.d && printf '[[registry]]\\nlocation = "${ZOT}:5000"\\ninsecure = true\\n' > /etc/containers/registries.conf.d/50-e2e.conf`,
    'CMD ["/sbin/init"]',
    "",
  ].join("\n");
}

/** `podman run` arguments for the host container (outer podman: Podman 4.9 flags only). */
export function hostRunArgs(image: string, model: string | null, zotAddress: string): string[] {
  return [
    "run",
    "-d",
    "--name",
    HOST,
    "--hostname",
    DOMAIN,
    "--privileged",
    "--systemd=always",
    // The whole instance runs in here (Bun, Postgres, Podman, conmon, health checks). Podman's
    // default pids limit (2048) is a cap no real server has: on CI it ran out mid-install
    // (pthread_create: Resource temporarily unavailable) and Bun services aborted.
    "--pids-limit=-1",
    "--network",
    NETWORK,
    "--add-host",
    `${DOMAIN}:127.0.0.1`,
    // Name resolution on the test network needs netavark/aardvark (or CNI's dnsname plugin).
    "--add-host",
    `${ZOT}:${zotAddress}`,
    "-v",
    `${LOG_DIR}/releases:/e2e/releases:ro`,
    "-v",
    `${join(REPO_ROOT, "scripts/selfhost.sh")}:/e2e/selfhost.sh:ro`,
    ...(model ? ["-v", `${model}:/e2e/${MODEL_FILE}:ro`] : []),
    image,
  ];
}

async function startHost(distro: Distro, model: string | null, zotAddress: string): Promise<void> {
  const dir = join(LOG_DIR, `host-${distro}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Containerfile"), hostContainerfile(distro));
  const image = `${LOCAL}/host-${distro}:latest`;
  build(["-t", image, dir]);
  podman(hostRunArgs(image, model, zotAddress));
  for (let i = 0; i < 60; i++) {
    const state = podman(["exec", HOST, "systemctl", "is-system-running"], { allowFail: true, quiet: true }).trim();
    if (state === "running" || state === "degraded") return;
    await Bun.sleep(2000);
  }
  throw new StepError("systemd in the host container did not come up");
}

function collectLogs(): void {
  if (!podman(["ps", "-a", "--format", "{{.Names}}"], { quiet: true }).includes(HOST)) return;
  const journal = inHost("journalctl --user --no-pager -o short-iso-precise -n 5000 2>&1 || true", {
    user: true,
    allowFail: true,
  });
  writeFileSync(join(LOG_DIR, "journal-user.log"), journal);
  writeFileSync(
    join(LOG_DIR, "journal-system.log"),
    inHost("journalctl --no-pager -o short-iso-precise -n 2000 2>&1 || true", { allowFail: true }),
  );
}

/**
 * What the e2e removes before it builds. Each run builds 14 images (about 5 GB) tagged with its
 * commit, and the release images (0.0.0-e2e.*) are built FROM those, so they are their children:
 * removing a parent while a child exists only untags it. So the children go first (every run
 * rebuilds them), then any dangling former children (pruned by their own label, nothing else),
 * then the other commits' images. The host images (host-<distro>:latest) are kept: they change
 * only with the e2e itself.
 */
export function cleanupPlan(tags: readonly string[], commit: string): { releases: string[]; stale: string[] } {
  const current = commit.slice(0, 12);
  const ours = tags.filter((t) => t.startsWith(`${LOCAL}/`) && !t.startsWith(`${LOCAL}/host-`));
  const tagOf = (t: string) => t.slice(t.lastIndexOf(":") + 1);
  return {
    releases: ours.filter((t) => tagOf(t).startsWith("0.0.0-e2e.")),
    stale: ours.filter((t) => tagOf(t) !== current && !tagOf(t).startsWith("0.0.0-e2e.")),
  };
}

export const RELEASE_LABEL = "org.commonair.e2e-release";

function removeStaleImages(commit: string): void {
  const tags = podman(["images", "--format", "{{.Repository}}:{{.Tag}}"], { quiet: true }).split("\n");
  const { releases, stale } = cleanupPlan(tags, commit);
  if (releases.length) podman(["rmi", "-f", ...releases], { allowFail: true, quiet: true });
  // Untagged release images of earlier runs, which still pin their commit's layers. The filter
  // keeps this to dangling images the e2e labelled: a developer's build cache is not touched.
  podman(["image", "prune", "-f", "--filter", `label=${RELEASE_LABEL}`], { allowFail: true, quiet: true });
  if (stale.length) podman(["rmi", "-f", ...stale], { allowFail: true, quiet: true });
}

function cleanup(): void {
  for (const c of [HOST, ZOT]) podman(["rm", "-f", "-t", "5", c], { allowFail: true, quiet: true });
  podman(["network", "rm", "-f", NETWORK], { allowFail: true, quiet: true });
}

// --- checks -------------------------------------------------------------------------------

const ROOT_CA =
  '"$(podman volume inspect commonair-caddy-data --format "{{.Mountpoint}}")/caddy/pki/authorities/local/root.crt"';

function checkHttps(): void {
  for (const path of ["/", "/api/status"]) {
    const code = inHost(`curl -sS -o /dev/null -w '%{http_code}' --cacert ${ROOT_CA} https://${DOMAIN}${path}`, {
      user: true,
    }).trim();
    expectThat(code.startsWith("2"), `https://${DOMAIN}${path} answers ${code} through the internal CA`);
  }
}

// Browser access to object storage (ADR 0024): presigned URLs signed by the API's own storage
// config, opened through Caddy and its internal CA as a browser would.

/** Presigned URLs for one check run, as the api container's storage config signs them. */
export interface Presigned {
  endpoint: string;
  upload: string;
  outside: string;
  download: string;
  incomingRead: string;
  evidence: string;
  backups: string;
}

export const uploadBody = (run: string) => `commonair e2e upload ${run}`;
export const exportBody = (run: string) => `commonair e2e export ${run}`;
export const EXPORT_FILENAME = "e2e-export.zip";

/**
 * JavaScript for `bun -e` in the api container (the workspace is at /app, so the storage
 * package resolves its own dependencies). `presign` stores an export object and prints the
 * presigned URLs as JSON; `verify` prints the uploaded object's body (null when missing) and
 * deletes both objects.
 */
export function storageScript(run: string, op: "presign" | "verify"): string {
  const c = JSON.stringify({
    run,
    op,
    uploadKey: `incoming/e2e/${run}.png`,
    outsideKey: `public/e2e/${run}.png`,
    exportKey: `e2e/${run}.zip`,
    upload: uploadBody(run),
    export: exportBody(run),
    filename: EXPORT_FILENAME,
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
const media = env.S3_BUCKET_MEDIA;
const exportsBucket = env.S3_BUCKET_EXPORTS;
const put = { expiresSeconds: 600, contentType: "image/png", contentLength: new TextEncoder().encode(c.upload).length };
if (c.op === "presign") {
  await s.put(exportsBucket, c.exportKey, c.export, { contentType: "application/zip" });
  console.log(JSON.stringify({
    endpoint: env.S3_PUBLIC_ENDPOINT ?? "",
    upload: await s.presignPut(media, c.uploadKey, put),
    outside: await s.presignPut(media, c.outsideKey, put),
    download: await s.presignGet(exportsBucket, c.exportKey, { expiresSeconds: 600, filename: c.filename }),
    incomingRead: await s.presignGet(media, c.uploadKey, { expiresSeconds: 600 }),
    evidence: await s.presignGet(env.S3_BUCKET_EVIDENCE, c.uploadKey, { expiresSeconds: 600 }),
    backups: await s.presignGet(env.S3_BUCKET_BACKUPS, c.uploadKey, { expiresSeconds: 600 }),
  }));
} else {
  const res = await s.get(media, c.uploadKey);
  const uploaded = res ? await res.text() : null;
  for (const key of [c.uploadKey, c.outsideKey]) await s.delete(media, key);
  await s.delete(exportsBucket, c.exportKey);
  console.log(JSON.stringify({ uploaded }));
}
`;
}

/**
 * Requests that must not succeed through Caddy: none may be 2xx. Most carry a valid signature,
 * so Garage itself would accept them; only Caddy's allowlist stands in the way.
 */
export function refusedRequests(p: Presigned): [what: string, method: string, url: string][] {
  const exportsBucket = new URL(p.download).pathname.split("/")[1];
  const origin = new URL(p.download).origin;
  return [
    ["an unsigned PUT to incoming/", "PUT", p.upload.split("?")[0]!],
    ["a presigned-looking GET of incoming/", "GET", p.incomingRead],
    ["a signed PUT outside incoming/", "PUT", p.outside],
    ["a signed GET of the evidence bucket", "GET", p.evidence],
    ["a signed GET of the backups bucket", "GET", p.backups],
    ["a listing of the exports bucket", "GET", `${origin}/${exportsBucket}?list-type=2`],
    ["a DELETE of the export", "DELETE", p.download],
    ["a DELETE of the upload", "DELETE", p.upload],
  ];
}

/** Runs a storageScript in the api container; its last output line is JSON. */
function inApi<T>(script: string): T {
  // Base64 keeps the script out of the host shell's quoting.
  const b64 = Buffer.from(script).toString("base64");
  const out = inHost(`podman exec -w /app/packages/storage commonair-api bun -e "$(printf %s ${b64} | base64 -d)"`, {
    user: true,
  });
  return JSON.parse(out.trim().split("\n").at(-1) ?? "null") as T;
}

const curlTo = (url: string) => `--cacert ${ROOT_CA} '${url}'`;

function checkBrowserStorage(label: string): void {
  const run = `${label}-${Date.now()}`;
  const p = inApi<Presigned>(storageScript(run, "presign"));
  expectThat(p.endpoint === `https://${DOMAIN}`, `S3_PUBLIC_ENDPOINT is https://${DOMAIN} (${p.endpoint || "unset"})`);
  for (const [name, url] of Object.entries(p))
    if (name !== "endpoint")
      expectThat(url.startsWith(`https://${DOMAIN}/`), `the presigned ${name} URL is on https://${DOMAIN}/`);

  // A presigned PUT into incoming/, as the web app's upload does it.
  const put = inHost(
    `curl -sS -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: image/png' ` +
      `--data-binary '${uploadBody(run)}' ${curlTo(p.upload)}`,
    { user: true },
  ).trim();
  expectThat(put.startsWith("2"), `a presigned PUT into incoming/ through Caddy answers ${put}`);

  // A presigned export GET: the exact bytes and the disposition the presign asked for.
  const got = inHost(`curl -sS -i ${curlTo(p.download)}`, { user: true });
  const split = got.indexOf("\r\n\r\n");
  const head = got.slice(0, split);
  const body = got.slice(split + 4);
  const status = /^HTTP\/\S+ (\d+)/.exec(head)?.[1] ?? "";
  const disposition = /^content-disposition: (.*?)\r?$/im.exec(head)?.[1] ?? "";
  expectThat(status === "200", `a presigned export GET through Caddy answers ${status || "nothing"}`);
  expectThat(body === exportBody(run), "the export download returns the stored bytes");
  expectThat(
    disposition === `attachment; filename="${EXPORT_FILENAME}"`,
    `the export download carries the presigned disposition (${disposition || "none"})`,
  );

  for (const [what, method, url] of refusedRequests(p)) {
    const code = inHost(`curl -sS -o /dev/null -w '%{http_code}' -X ${method} ${curlTo(url)}`, { user: true }).trim();
    expectThat(!code.startsWith("2"), `${what} is refused (${code})`);
  }

  const { uploaded } = inApi<{ uploaded: string | null }>(storageScript(run, "verify"));
  expectThat(uploaded === uploadBody(run), "the uploaded object is in the media bucket, byte for byte");
}

/** Keys the internet-facing Caddy container must never hold: each unit gets only its own keys. */
export const CADDY_FORBIDDEN: readonly RegExp[] = [
  /^DATABASE_URL$/,
  /^POSTGRES_(APP_)?PASSWORD$/,
  /^SESSION_/,
  /^AUTH_SECRET$/,
  /^S3_SECRET/,
  /^S3_EVIDENCE_/,
];

/** The variable names of `env` output (KEY=value lines; values are never returned). */
export function envKeys(envOutput: string): string[] {
  return envOutput
    .split("\n")
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .map((l) => l.slice(0, l.indexOf("=")));
}

/** Names in `env` output that match any of the patterns. */
export function forbiddenKeys(envOutput: string, patterns: readonly RegExp[]): string[] {
  return envKeys(envOutput).filter((k) => patterns.some((p) => p.test(k)));
}

/** Each container reads only its keys of commonair.env (scripts/selfhost/render-env.sh). */
function checkUnitEnv(): void {
  // Names only (`KEY=`): the e2e log keeps command output, and these values are secrets.
  const namesOf = (container: string) => inHost(`podman exec ${container} env | sed 's/=.*/=/'`, { user: true });
  const caddy = namesOf("commonair-caddy");
  const leaked = forbiddenKeys(caddy, CADDY_FORBIDDEN);
  expectThat(
    leaked.length === 0,
    `commonair-caddy holds no database, session or S3 secret (${leaked.join(", ") || "none"})`,
  );
  expectThat(envKeys(caddy).includes("PUBLIC_HOSTNAME"), "commonair-caddy has PUBLIC_HOSTNAME");
  const api = namesOf("commonair-api");
  expectThat(envKeys(api).includes("DATABASE_URL"), "commonair-api has DATABASE_URL");
  expectThat(envKeys(api).includes("AUTH_SECRET"), "commonair-api has AUTH_SECRET");
}

// --- network exposure ---------------------------------------------------------------------

/**
 * TCP listeners the host may have: the public ports on any address (IPv6 and IPv4), and the two
 * loopback-only ones an operator procedure needs (Garage for the off-host object copy, Grafana
 * for an SSH tunnel). Everything else stays inside the commonair network.
 */
export const PUBLIC_TCP_PORTS = [80, 443, 1935, 6667, 6697] as const;
export const LOOPBACK_TCP_PORTS = [3030, 3900] as const;
/** Listeners that must be there once the instance is up (IRC may wait for its certificate). */
export const REQUIRED_TCP_PORTS = [80, 443, 1935] as const;

export interface Listener {
  address: string;
  port: number;
}

/** Local address and port of each line of `ss -Hltn(e)` (`*:80`, `0.0.0.0:80`, `[::]:80`, `127.0.0.1:3900`). */
export function listeners(ssOutput: string): Listener[] {
  return ssOutput
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[3] ?? "")
    .filter(Boolean)
    .map((local) => {
      const i = local.lastIndexOf(":");
      return {
        address: local
          .slice(0, i)
          .replace(/^\[|\]$/g, "")
          .replace(/%.*$/, ""),
        port: Number(local.slice(i + 1)),
      };
    });
}

const isLoopback = (address: string) => address === "::1" || address.startsWith("127.");

/** Listeners outside the allowlist, as `address:port`. */
export function unexpectedListeners(ssOutput: string): string[] {
  return listeners(ssOutput)
    .filter(
      ({ address, port }) =>
        !(PUBLIC_TCP_PORTS as readonly number[]).includes(port) &&
        !((LOOPBACK_TCP_PORTS as readonly number[]).includes(port) && isLoopback(address)),
    )
    .map(({ address, port }) => `${address}:${port}`);
}

/** Required public ports nobody listens on. */
export function missingListeners(ssOutput: string): number[] {
  const ports = new Set(listeners(ssOutput).map((l) => l.port));
  return REQUIRED_TCP_PORTS.filter((p) => !ports.has(p));
}

/**
 * The lines of `ss -Hltne` the instance is judged by: every listener except the operating
 * system's own services (`cgroup:/system.slice/…`: sshd, systemd-resolved on Fedora). The
 * instance runs only in the service user's slice, and anything else, root's included, is judged.
 */
export function judgedListeners(ssOutput: string): string {
  return ssOutput
    .split("\n")
    .filter((l) => !/\scgroup:\/system\.slice\//.test(l))
    .join("\n");
}

function checkListeners(): void {
  const ss = judgedListeners(inHost("ss -Hltne"));
  const extra = unexpectedListeners(ss);
  expectThat(
    extra.length === 0,
    `the host listens only on the allowlisted TCP ports (extra: ${extra.join(", ") || "none"})`,
  );
  const missing = missingListeners(ss);
  expectThat(missing.length === 0, `the public TCP ports listen (missing: ${missing.join(", ") || "none"})`);
}

/** A path under the API's auth prefix: its non-GET requests are rate-limited per client address first. */
export const AUTH_PROBE_PATH = "/api/auth/e2e-client-address";
/** The API's auth bucket allows this many non-GET requests per address and minute. */
export const AUTH_LIMIT = 10;
/** Distinct local source addresses on the host (all of 127.0.0.0/8 is local). */
export const SOURCES = { a: "127.0.0.2", b: "127.0.0.3", c: "127.0.0.4" } as const;
export const SPOOFED = "203.0.113.7";

/** curl of one POST to the auth probe from `source`, printing only the status code. */
export function probeCommand(source: string, forwardedFor?: string): string {
  const xff = forwardedFor ? `-H 'X-Forwarded-For: ${forwardedFor}' ` : "";
  return (
    `curl -sS -o /dev/null -w '%{http_code}\\n' --interface ${source} -X POST -H 'content-type: application/json' ` +
    `${xff}--data '{}' --cacert ${ROOT_CA} https://${DOMAIN}${AUTH_PROBE_PATH}`
  );
}

/**
 * What the API thinks the client address is, through its per-address rate limit: the API (behind
 * Caddy and its socket-activated public port) must tell two local sources apart, and a client's
 * own X-Forwarded-For must not pick its address.
 */
function checkClientAddresses(): void {
  const codes = (cmd: string, n: number) =>
    inHost(Array.from({ length: n }, () => cmd).join("; "), { user: true })
      .trim()
      .split("\n")
      .map((c) => c.trim());
  // Source a spends its whole minute's budget, then one more is refused.
  const a = codes(probeCommand(SOURCES.a), AUTH_LIMIT + 1);
  expectThat(
    a.slice(0, AUTH_LIMIT).every((c) => c !== "429") && a.at(-1) === "429",
    `${AUTH_LIMIT} auth requests from ${SOURCES.a} pass and the next is rate-limited (${a.join(" ")})`,
  );
  // Through rootless port forwarding every client would share a's address and be refused too.
  const [b] = codes(probeCommand(SOURCES.b), 1);
  expectThat(b !== "429" && b !== "", `${SOURCES.b} is a different client to the API (${b})`);
  // A believed X-Forwarded-For would make a a new, unlimited client.
  const [spoofedNew] = codes(probeCommand(SOURCES.a, SPOOFED), 1);
  expectThat(
    spoofedNew === "429",
    `${SOURCES.a} claiming X-Forwarded-For: ${SPOOFED} is still ${SOURCES.a} (${spoofedNew})`,
  );
  // And one that claims a's address is not refused as a.
  const [spoofedOld] = codes(probeCommand(SOURCES.c, SOURCES.a), 1);
  expectThat(
    spoofedOld !== "429" && spoofedOld !== "",
    `${SOURCES.c} claiming X-Forwarded-For: ${SOURCES.a} is not taken for ${SOURCES.a} (${spoofedOld})`,
  );
}

/** HTTPS over IPv6 loopback when the host has it: the socket listens on IPv6 as well. */
function checkIpv6(): void {
  const has = inHost("ip -6 addr show dev lo 2>/dev/null | grep -q 'inet6 ::1' && echo yes || echo no").trim();
  if (has !== "yes") {
    log("skip: the host container has no IPv6 loopback");
    return;
  }
  const code = inHost(
    `curl -sS -o /dev/null -w '%{http_code}' -g --resolve '${DOMAIN}:443:[::1]' --cacert ${ROOT_CA} https://${DOMAIN}/`,
    { user: true },
  ).trim();
  expectThat(code.startsWith("2"), `https://${DOMAIN}/ answers ${code} over IPv6 (::1)`);
}

/** Valkey refuses clients without its password; the services' URL carries it; ps never shows it. */
function checkValkeyAuth(): void {
  const anonymous = inHost("podman exec commonair-valkey valkey-cli ping 2>&1 || true", { user: true });
  expectThat(
    /NOAUTH/.test(anonymous) && !/PONG/.test(anonymous),
    `valkey-cli without the password is refused (${anonymous.trim()})`,
  );
  const authed = inHost(`podman exec commonair-valkey sh -c 'VALKEYCLI_AUTH="$VALKEY_PASSWORD" valkey-cli ping'`, {
    user: true,
  }).trim();
  expectThat(authed === "PONG", `valkey-cli with the password gets PONG (${authed})`);
  // Prints only a verdict: the URL holds the password.
  const url = inHost(
    `podman exec commonair-api sh -c 'case "$VALKEY_URL" in redis://:?*@valkey:6379) echo with-password ;; *) echo without ;; esac'`,
    { user: true },
  ).trim();
  expectThat(url === "with-password", `the api's VALKEY_URL carries the password (${url})`);
  const shown = inHost(
    `pw=$(sed -n 's/^VALKEY_PASSWORD=//p' ~/.config/commonair/commonair.env); ` +
      `[ -n "$pw" ] && podman top commonair-valkey args | grep -cF "$pw" || true`,
    { user: true },
  ).trim();
  expectThat(shown === "0", `no process in commonair-valkey shows the password on its command line (${shown})`);
}

function installedVersion(): string {
  return /version:\s+(\S+)/.exec(inHost("sh ~/commonair/selfhost.sh status", { user: true }))?.[1] ?? "";
}

/** Monotonic µs from systemd: when a unit last entered active, or its main process exited. */
function stamp(unit: string, property: string): number {
  return Number(inHost(`systemctl --user show ${unit} --property=${property} --value`, { user: true }).trim());
}

function prop(unit: string, property: string): string {
  return inHost(`systemctl --user show ${unit} --property=${property} --value`, { user: true }).trim();
}

/** migrate's last run, taken before an upgrade so the check below can tell it ran again. */
interface MigrateRun {
  invocation: string;
  started: number;
}
function migrateRun(): MigrateRun {
  return {
    invocation: prop("commonair-migrate.service", "InvocationID"),
    started: stamp("commonair-migrate.service", "ExecMainStartTimestampMonotonic"),
  };
}

/** The upgrade re-ran migrate (a new invocation, started after the old one) and api and worker
 * started only after it finished. A leftover timestamp from the install cannot pass this. */
export function migratedFirst(
  before: MigrateRun,
  after: MigrateRun & { exited: number },
  started: Record<string, number>,
): string[] {
  const problems: string[] = [];
  if (!after.invocation || after.invocation === before.invocation)
    problems.push(`migrate did not run again (invocation ${after.invocation || "none"})`);
  if (!(after.started > before.started))
    problems.push(`migrate's last start ${after.started} is not after the pre-upgrade one ${before.started}`);
  if (!(after.exited >= after.started)) problems.push(`migrate has not finished (exit ${after.exited})`);
  for (const [unit, at] of Object.entries(started))
    if (!(at > after.exited)) problems.push(`${unit} started at ${at}, before migrate finished at ${after.exited}`);
  return problems;
}

function checkMigrateFirst(before: MigrateRun): void {
  const after = { ...migrateRun(), exited: stamp("commonair-migrate.service", "ExecMainExitTimestampMonotonic") };
  const started = Object.fromEntries(
    ["api", "worker"].map((s) => [s, stamp(`commonair-${s}.service`, "ExecMainStartTimestampMonotonic")]),
  );
  const problems = migratedFirst(before, after, started);
  expectThat(problems.length === 0, `the upgrade re-ran migrate before api and worker: ${problems.join("; ") || "ok"}`);
}

/** Kills a container behind systemd's back: Restart=always must bring it back as a new one. */
async function checkRestart(service: string): Promise<void> {
  const unit = `commonair-${service}.service`;
  const container = `commonair-${service}`;
  const id = () => inHost(`podman inspect --format '{{.Id}}' ${container}`, { user: true, allowFail: true }).trim();
  const restarts = () => Number(prop(unit, "NRestarts"));
  const idBefore = id();
  const nBefore = restarts();
  inHost(`podman kill ${container}`, { user: true });
  for (let i = 0; i < 90; i++) {
    await Bun.sleep(2000);
    const active = inHost(`systemctl --user is-active ${unit}`, { user: true, allowFail: true }).trim();
    const healthy =
      inHost(`podman inspect --format '{{.State.Health.Status}}' ${container}`, {
        user: true,
        allowFail: true,
      }).trim() === "healthy";
    if (active === "active" && healthy && restarts() > nBefore && id() && id() !== idBefore) {
      expectThat(true, `${service} came back by itself after podman kill (NRestarts ${nBefore} -> ${restarts()})`);
      return;
    }
  }
  // What a stuck restart needs to be diagnosed: the unit's cgroup tree as systemd left it.
  inHost(
    `rel=$(systemctl --user show ${unit} -p ControlGroup --value); [ -n "$rel" ] || exit 0; cg=/sys/fs/cgroup$rel; ` +
      `systemctl --user status ${unit} --no-pager -n 0; ` +
      `find "$cg" -type d | while read -r d; do printf '%s procs=[%s] subtree=[%s] %s\\n' "$d" ` +
      `"$(tr '\\n' ' ' < "$d/cgroup.procs")" "$(cat "$d/cgroup.subtree_control")" "$(tr '\\n' ' ' < "$d/cgroup.events")"; done; ` +
      `podman ps -a --format '{{.Names}} {{.Status}}'`,
    { user: true, allowFail: true },
  );
  expectThat(false, `${service} did not come back within 180 s of podman kill`);
}

// --- main ---------------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const distro = (arg("--distro") ?? "debian") as Distro;
  if (!(distro in HOST_IMAGES)) throw new Error(`--distro must be debian or fedora, not ${distro}`);
  const keep = process.argv.includes("--keep");
  rmSync(LOG_DIR, { recursive: true, force: true });
  mkdirSync(LOG_DIR, { recursive: true });
  const commit = run(["git", "rev-parse", "HEAD"]).trim();
  const localModel = join(REPO_ROOT, ".cache/models", MODEL_FILE);
  const model = existsSync(localModel) ? localModel : null;
  const sh = "sh /e2e/selfhost.sh";

  cleanup();
  try {
    await step("build the release images", () => {
      removeStaleImages(commit);
      buildImages(commit);
    });
    await step("start the Zot registry", async () => {
      podman(["network", "create", NETWORK]);
      podman(["run", "-d", "--name", ZOT, "--network", NETWORK, "-p", "127.0.0.1::5000", ZOT_IMAGE]);
      for (let i = 0; i < 30; i++) {
        if (podman(["port", ZOT, "5000/tcp"], { allowFail: true, quiet: true }).trim()) break;
        await Bun.sleep(1000);
      }
    });
    const port = podman(["port", ZOT, "5000/tcp"]).trim().split(":").at(-1)!;
    const zotAddress = podman([
      "inspect",
      "--format",
      `{{(index .NetworkSettings.Networks "${NETWORK}").IPAddress}}`,
      ZOT,
    ]).trim();
    if (!zotAddress) throw new StepError(`no address for ${ZOT} on ${NETWORK}`);

    const v1 = "0.0.0-e2e.1";
    const v2 = "0.0.0-e2e.2";
    const v3 = "0.0.0-e2e.3";
    await step(`release ${v1}: push and bundle`, () =>
      release(
        v1,
        commit,
        push(v1, (n) => `${LOCAL}/${n}:${commit.slice(0, 12)}`, port),
      ),
    );
    await step(`start a ${distro} host`, () => startHost(distro, model, zotAddress));

    await step(`install ${v1}`, () => {
      const bundle = `/e2e/releases/${v1}/${bundleAssetName(v1)}`;
      inHost(
        `${sh} install --bundle ${bundle} --tls internal --domain ${DOMAIN} --email ops@${DOMAIN} ` +
          `--registry ${MIRROR} --public-ip 127.0.0.1 ${model ? `--model /e2e/${MODEL_FILE} ` : ""}--yes`,
      );
      expectThat(installedVersion() === v1, `status reports ${v1}`);
      checkHttps();
      checkBrowserStorage("install");
      checkUnitEnv();
      checkValkeyAuth();
      checkClientAddresses();
      checkIpv6();
      checkListeners();
    });

    await step(`release ${v2} (new digests) and upgrade`, async () => {
      relabel(commit, v2);
      await release(
        v2,
        commit,
        push(v2, (n) => `${LOCAL}/${n}:${v2}`, port),
      );
      const before = migrateRun();
      inHost(`sh ~/commonair/selfhost.sh upgrade --bundle /e2e/releases/${v2}/${bundleAssetName(v2)}`, { user: true });
      expectThat(installedVersion() === v2, `status reports ${v2}`);
      checkMigrateFirst(before);
      checkHttps();
      checkBrowserStorage("upgrade");
      checkUnitEnv();
      checkValkeyAuth();
      checkListeners();
    });

    // The session-ten bug: a crashed worker stayed down under compose. Under Quadlet, systemd
    // restarts it.
    await step("a killed worker comes back by itself", () => checkRestart("worker"));

    await step(`broken release ${v3} rolls back to ${v2}`, async () => {
      relabel(commit, v3, ["api"]);
      await release(
        v3,
        commit,
        push(v3, (n) => `${LOCAL}/${n}:${v3}`, port),
      );
      const out = inHost(
        `sh ~/commonair/selfhost.sh upgrade --bundle /e2e/releases/${v3}/${bundleAssetName(v3)} 2>&1; echo "exit=$?"`,
        { user: true, env: { COMMONAIR_HEALTH_TIMEOUT: "240" } },
      );
      expectThat(/exit=1\s*$/.test(out), "the broken upgrade exits non-zero");
      expectThat(out.includes(`rolled back to ${v2}, which is healthy`), "it reports a healthy rollback");
      expectThat(installedVersion() === v2, `status reports ${v2} again`);
      checkHttps();
    });
  } catch (e) {
    collectLogs();
    throw e;
  } finally {
    writeFileSync(join(LOG_DIR, "timings.json"), JSON.stringify(Object.fromEntries(timings), null, 2));
    if (!keep) cleanup();
    else console.log(`--keep: ${HOST} and ${ZOT} are still running (podman exec -it ${HOST} bash)`);
  }
}

if (import.meta.main) {
  try {
    await main();
    console.log(`selfhost e2e passed; timings in ${join(LOG_DIR, "timings.json")}`);
  } catch (e) {
    console.error(`selfhost e2e FAILED: ${(e as Error).message}\nlogs: ${LOG_DIR}`);
    process.exit(1);
  }
}
