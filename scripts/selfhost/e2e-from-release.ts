// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e2e.ts --from-release <tag>` (R0-release-prep): upgrade from what we published, not from a
 * second build of the same tree. A stranger's instance starts from a signed release on ghcr, so
 * this starts there too:
 *
 * 1. Reads the release's assets from GitHub (never a hard-coded list) and downloads the self-host
 *    bundle, `SHA256SUMS`, `SHA256SUMS.sigstore.json` and `release-manifest.json`, retrying a
 *    rate limit or a 5xx with backoff. Offline it refuses at once instead of hanging.
 * 2. In the fresh host, as root, installs cosign 3.x exactly as install.md does (the pinned binary,
 *    checked against the SHA-256 in scripts/release/tools.ts) and verifies the downloads exactly as
 *    verifying.md does: `cosign verify-blob` with that page's identity regexp and issuer, then
 *    `sha256sum --check --ignore-missing`. It verifies once more with the exact identity of the
 *    tag's own workflow run (RELEASE_SIGNERS), which pins the signature to that one tag.
 * 3. Unpacks the bundle and runs the release's own `selfhost.sh install --version <tag>
 *    --require-signature` (it downloads and verifies again itself), pulling the images from ghcr.
 *    A pull refused by ghcr's rate limit is retried with backoff (`--reinstall`); the optional Zot
 *    mirror (e2e-mirror.ts) also stands in for ghcr.io.
 * 4. Seeds a little data with the release's own code in its api container (seedScript): two
 *    members, a channel, a follow and a ledger posting, and reads the channel back through the
 *    public API.
 * 5. e2e.ts then upgrades to the candidate built from the tree with the INSTALLED `selfhost.sh`
 *    (the published release's, as a stranger's `upgrade` runs it), and checks that the data
 *    survived (seedProblems), that migrate ran once and that `status` reports the new version,
 *    then rolls back from a broken release as the default run does.
 *
 * The images come from ghcr, so this needs network access; CI runs it on the workflow_dispatch
 * run only (FROM_RELEASE_EVENTS). With the default --state and --storage only: the releases it
 * starts from predate external Postgres, Valkey and S3 support.
 *
 * Signing identity across releases: every tag so far was signed by `.github/workflows/release.yml`
 * of this repository, running for that tag. If the workflow file ever moves, or releases start to
 * be signed from another ref, add a RELEASE_SIGNERS entry with the first tag it applies to; older
 * tags keep verifying against the identity that signed them.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SITE } from "../../packages/config/src/site.ts";
import { signatureAsset } from "../release/assets.ts";
import { compareVersions, parseVersion } from "../release/changelog.ts";
import { CHECKSUMS_ASSET, MANIFEST_ASSET, bundleAssetName } from "../release/manifest.ts";
import { TOOLS } from "../release/tools.ts";
import type { Expect, InHost } from "./e2e-s3.ts";

export const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
/** The repository whose releases are installed: SITE.repository.url, as selfhost.sh defaults to. */
export const RELEASE_REPOSITORY = SITE.repository.url;

/**
 * Which workflow signed which tags, oldest first. An entry applies from `since` up to the next
 * entry's `since`. verifying.md documents the current one; a test keeps them equal.
 */
export const RELEASE_SIGNERS: readonly { since: string; workflow: string }[] = [
  { since: "v0.1.0-rc.1", workflow: ".github/workflows/release.yml" },
];

/** The CI events that may run this mode (it pulls every image from ghcr). */
export const FROM_RELEASE_EVENTS: readonly string[] = ["workflow_dispatch"];

/** The tag as given (`v0.1.0-rc.2`) and its version (`0.1.0-rc.2`); throws unless it is a release tag. */
export function releaseTag(tag: string): { tag: string; version: string } {
  if (!tag.startsWith("v") || parseVersion(tag) === null)
    throw new Error(`--from-release takes a release tag such as v0.1.0-rc.2, not ${tag || "nothing"}`);
  return { tag, version: tag.slice(1) };
}

/** The workflow that signed `tag` (RELEASE_SIGNERS). */
export function signerFor(tag: string, signers = RELEASE_SIGNERS): string {
  let workflow: string | null = null;
  for (const s of signers) if (compareVersions(s.since, tag) <= 0) workflow = s.workflow;
  if (!workflow) throw new Error(`no known signing workflow for ${tag} (RELEASE_SIGNERS starts later)`);
  return workflow;
}

const escapeDots = (s: string) => s.replace(/\./g, "\\.");

/** verifying.md's `--certificate-identity-regexp`: any version tag of the workflow, nothing else. */
export function identityRegexp(repoUrl: string, workflow: string): string {
  return `^${escapeDots(repoUrl)}/${escapeDots(workflow)}@refs/tags/v`;
}

/** The exact identity of the workflow run that signed `tag`. */
export function exactIdentity(repoUrl: string, tag: string, signers = RELEASE_SIGNERS): string {
  return `${repoUrl}/${signerFor(tag, signers)}@refs/tags/${tag}`;
}

/** POSIX shell single-quoting. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The verification commands, as argv, in order: verifying.md's "Release assets" commands with its
 * identity flags (the regexp form), then the same signature pinned to this tag's identity.
 * They run in the directory holding the downloads.
 */
export function verifyCommands(tag: string, repoUrl = RELEASE_REPOSITORY, signers = RELEASE_SIGNERS): string[][] {
  const sig = signatureAsset(CHECKSUMS_ASSET);
  const issuer = ["--certificate-oidc-issuer", OIDC_ISSUER];
  const workflow = signerFor(tag, signers);
  return [
    [
      "cosign",
      "verify-blob",
      "--bundle",
      sig,
      "--certificate-identity-regexp",
      identityRegexp(repoUrl, workflow),
      ...issuer,
      CHECKSUMS_ASSET,
    ],
    [
      "cosign",
      "verify-blob",
      "--bundle",
      sig,
      "--certificate-identity",
      exactIdentity(repoUrl, tag, signers),
      ...issuer,
      CHECKSUMS_ASSET,
    ],
    ["sha256sum", "--check", "--ignore-missing", CHECKSUMS_ASSET],
  ];
}

// --- release assets -------------------------------------------------------------------------

export interface ReleaseAsset {
  name: string;
  /** browser_download_url */
  url: string;
  size: number;
}

/** The assets of a GitHub "get a release by tag name" response. */
export function releaseAssets(json: unknown): ReleaseAsset[] {
  const assets = (json as { assets?: unknown } | null)?.assets;
  if (!Array.isArray(assets)) throw new Error("the GitHub release has no asset list");
  return assets.map((a: { name?: unknown; browser_download_url?: unknown; size?: unknown }) => {
    if (typeof a.name !== "string" || typeof a.browser_download_url !== "string")
      throw new Error("a GitHub release asset without a name or download URL");
    return { name: a.name, url: a.browser_download_url, size: typeof a.size === "number" ? a.size : 0 };
  });
}

/** What the from-release install downloads, by role. */
export interface SelectedAssets {
  bundle: ReleaseAsset;
  sums: ReleaseAsset;
  signature: ReleaseAsset;
  manifest: ReleaseAsset;
}

/**
 * Picks the four assets from what the release lists, by the names release.yml publishes
 * (manifest.ts, assets.ts). Fails naming every missing one and what the release does have.
 */
export function selectAssets(version: string, assets: readonly ReleaseAsset[]): SelectedAssets {
  const want = {
    bundle: bundleAssetName(version),
    sums: CHECKSUMS_ASSET,
    signature: signatureAsset(CHECKSUMS_ASSET),
    manifest: MANIFEST_ASSET,
  };
  const byName = new Map(assets.map((a) => [a.name, a]));
  const missing = Object.values(want).filter((n) => !byName.has(n));
  if (missing.length)
    throw new Error(
      `release v${version} lacks ${missing.join(", ")}; it has ${assets.map((a) => a.name).join(", ") || "no assets"}`,
    );
  const pick = (n: string) => byName.get(n) as ReleaseAsset;
  return {
    bundle: pick(want.bundle),
    sums: pick(want.sums),
    signature: pick(want.signature),
    manifest: pick(want.manifest),
  };
}

// --- network --------------------------------------------------------------------------------

export class OfflineError extends Error {}

/** The wait before retry `attempt` (0-based): base, ×3, ×9, … */
export const backoffMs = (attempt: number, baseMs: number) => baseMs * 3 ** attempt;

/** Whether an HTTP answer is worth another try: a rate limit or a server error. */
export function retryableStatus(status: number, headers: Headers): boolean {
  if (status === 429 || status >= 500) return true;
  // GitHub's primary rate limit answers 403 with no requests left.
  return status === 403 && headers.get("x-ratelimit-remaining") === "0";
}

export interface FetchDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
}
const realDeps: FetchDeps = { fetch: (u, i) => fetch(u, i), sleep: (ms) => Bun.sleep(ms) };

/**
 * fetch with a timeout per try and backoff on a rate limit, a 5xx or a network error. The last
 * answer is returned as it is (the caller reports a 4xx); a network error on the last try throws.
 */
export async function fetchWithBackoff(
  url: string,
  init: RequestInit = {},
  opts: { attempts?: number; baseMs?: number; timeoutMs?: number; deps?: FetchDeps } = {},
): Promise<Response> {
  const { attempts = 4, baseMs = 5000, timeoutMs = 60_000, deps = realDeps } = opts;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await deps.sleep(backoffMs(i - 1, baseMs));
    try {
      const res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (i < attempts - 1 && retryableStatus(res.status, res.headers)) continue;
      return res;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`${url}: ${(lastError as Error | undefined)?.message ?? "no answer"} after ${attempts} tries`);
}

/** The hosts this mode needs: GitHub's API and downloads, and ghcr for the images. */
export const NETWORK_PROBES = ["https://api.github.com/", "https://ghcr.io/v2/"] as const;

/**
 * Refuses at once when the network is not there: a fetch that cannot connect within `timeoutMs`
 * is offline. Any HTTP answer (ghcr's /v2/ is a 401) means the host is reachable.
 */
export async function assertOnline(deps: FetchDeps = realDeps, timeoutMs = 10_000): Promise<void> {
  for (const url of NETWORK_PROBES) {
    try {
      await deps.fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new OfflineError(
        `--from-release needs network access (GitHub releases and ghcr.io), and ${url} did not answer: ` +
          `${(e as Error).message}. It does not run offline; run the default e2e (no --from-release) instead.`,
      );
    }
  }
}

/** GitHub API headers; a token (GITHUB_TOKEN or GH_TOKEN) raises the rate limit, never required. */
export function githubHeaders(env: Record<string, string | undefined>): Record<string, string> {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** `https://api.github.com/repos/<owner>/<name>/releases/tags/<tag>` for a github.com repository URL. */
export function releaseApiUrl(repoUrl: string, tag: string): string {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\/?$/.exec(repoUrl);
  if (!m) throw new Error(`not a github.com repository URL: ${repoUrl}`);
  return `https://api.github.com/repos/${m[1]}/${m[2]}/releases/tags/${encodeURIComponent(tag)}`;
}

/**
 * Lists the release's assets and downloads the four into `dir`, each checked against its listed
 * size. Their integrity is checked in the host (verifyCommands), as a stranger checks it.
 */
export async function downloadRelease(
  tag: string,
  dir: string,
  opts: { repoUrl?: string; env?: Record<string, string | undefined>; deps?: FetchDeps } = {},
): Promise<SelectedAssets> {
  const { repoUrl = RELEASE_REPOSITORY, env = process.env, deps = realDeps } = opts;
  const { version } = releaseTag(tag);
  const api = releaseApiUrl(repoUrl, tag);
  const res = await fetchWithBackoff(api, { headers: githubHeaders(env) }, { deps });
  if (res.status === 404) throw new Error(`${repoUrl} has no release ${tag}`);
  if (!res.ok) throw new Error(`${api} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const selected = selectAssets(version, releaseAssets(await res.json()));
  mkdirSync(dir, { recursive: true });
  for (const asset of Object.values(selected)) {
    // Release downloads redirect to a storage host; no token goes along.
    const r = await fetchWithBackoff(asset.url, {}, { deps });
    if (!r.ok) throw new Error(`downloading ${asset.name} answered ${r.status}`);
    const data = new Uint8Array(await r.arrayBuffer());
    if (asset.size && data.byteLength !== asset.size)
      throw new Error(`${asset.name}: got ${data.byteLength} bytes, the release lists ${asset.size}`);
    writeFileSync(join(dir, asset.name), data);
  }
  return selected;
}

/** Why this mode may not run here, or null. On GitHub Actions only FROM_RELEASE_EVENTS may run it. */
export function fromReleaseRefusal(env: Record<string, string | undefined>): string | null {
  if (env.GITHUB_ACTIONS !== "true") return null;
  const event = env.GITHUB_EVENT_NAME ?? "";
  if (FROM_RELEASE_EVENTS.includes(event)) return null;
  return (
    `--from-release runs on CI only for ${FROM_RELEASE_EVENTS.join(", ")} (it pulls every image from ghcr), ` +
    `not for ${event || "an unknown event"}`
  );
}

// --- in the host ----------------------------------------------------------------------------

/** Where the downloads go inside the host, as a stranger's `mkdir -p ~/commonair-release`. */
export const HOST_RELEASE_DIR = "/root/commonair-release";

/** install.md's cosign install, as root in the host: the pinned binary or nothing. */
export function cosignInstallScript(arch: "amd64" | "arm64"): string {
  const asset = TOOLS.cosign.assets[`linux/${arch}`];
  return [
    'd="$(mktemp -d)"',
    `curl --proto '=https' --tlsv1.2 -fsSLo "$d/cosign" ${shellQuote(asset.url)}`,
    `echo "${asset.sha256}  $d/cosign" | sha256sum --check`,
    'install -m 0755 "$d/cosign" /usr/local/bin/cosign',
    'rm -rf "$d"',
    "cosign version",
  ].join(" && ");
}

/** The outer host's arch as the host container's (they are the same machine). */
export function hostArch(arch: string = process.arch): "amd64" | "arm64" {
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  throw new Error(`no cosign build for ${arch}`);
}

/**
 * Copies the downloads into HOST_RELEASE_DIR, verifies them (verifyCommands) and unpacks the
 * bundle there. Prints each command's output; sha256sum's line for the bundle must say OK.
 */
export function verifyAndUnpackScript(source: string, tag: string, repoUrl = RELEASE_REPOSITORY): string {
  const { version } = releaseTag(tag);
  const bundle = bundleAssetName(version);
  const chain = [
    `rm -rf ${HOST_RELEASE_DIR}`,
    `mkdir -p ${HOST_RELEASE_DIR}`,
    `cp ${shellQuote(source)}/* ${HOST_RELEASE_DIR}/`,
    `cd ${HOST_RELEASE_DIR}`,
    ...verifyCommands(tag, repoUrl).map((argv) => argv.map(shellQuote).join(" ")),
    `tar -xzf ${shellQuote(bundle)}`,
    `test -f commonair-selfhost_${version}/selfhost.sh`,
  ].join(" && ");
  // The first failure stops the chain; its output and the status come back either way.
  return `(${chain}) 2>&1; echo "exit=$?"`;
}

/** What a verified run printed must show: two good signatures and the bundle's checksum OK. */
export function verificationProblems(output: string, version: string): string[] {
  const problems: string[] = [];
  const status = exitStatus(output);
  if (status !== 0) problems.push(`the verification stopped with exit ${status ?? "unknown"}`);
  const verified = output.match(/^Verified OK$/gm)?.length ?? 0;
  if (verified !== 2) problems.push(`cosign printed "Verified OK" ${verified} times, not 2`);
  const bundle = bundleAssetName(version);
  if (!new RegExp(`^${bundle.replace(/\./g, "\\.")}: OK$`, "m").test(output))
    problems.push(`sha256sum did not report ${bundle}: OK`);
  if (/: FAILED/.test(output)) problems.push("sha256sum reported a FAILED checksum");
  return problems;
}

/**
 * The published release's own install, as root: its selfhost.sh, downloading the release itself
 * (--version) with the signature required. `extra` are the e2e's flags (TLS, address, model).
 */
export function publishedInstallCommand(tag: string, extra: string, reinstall = false): string {
  const { version } = releaseTag(tag);
  return (
    `cd ${HOST_RELEASE_DIR} && sh commonair-selfhost_${version}/selfhost.sh install --yes --version ${tag} ` +
    `--require-signature ${extra}${reinstall ? " --reinstall" : ""} 2>&1; echo "exit=$?"`
  );
}

/** A pull or a download refused by a registry's rate limit (ghcr, Docker Hub, GitHub). */
export function isRateLimited(output: string): boolean {
  return /toomanyrequests|too many requests|status:? ?429|rate limit/i.test(output);
}

/** The exit status an `…; echo "exit=$?"` command printed last, or null. */
export function exitStatus(output: string): number | null {
  const m = /exit=(\d+)\s*$/.exec(output);
  return m ? Number(m[1]) : null;
}

export interface UpgradeOutcome {
  ok: boolean;
  /** The upgrade failed and the published release came back. */
  rolledBack: boolean;
  /** Units the failed upgrade named as not healthy. */
  unhealthy: string[];
}

/** Reads `selfhost.sh upgrade … 2>&1; echo "exit=$?"` (any release's script; rc.2's words). */
export function upgradeOutcome(output: string): UpgradeOutcome {
  const unhealthy = [...output.matchAll(/not healthy after \d+s:([^\n]*)/g)].flatMap((m) =>
    (m[1] ?? "").trim().split(/\s+/).filter(Boolean),
  );
  return {
    ok: exitStatus(output) === 0,
    rolledBack: /rolled back to \S+, which is healthy/.test(output),
    unhealthy: [...new Set(unhealthy)],
  };
}

// --- seed data ------------------------------------------------------------------------------

export interface SeedNames {
  streamer: string;
  viewer: string;
  amountCents: number;
}

/** The seed's usernames for a run (lowercase, digits; a valid username and channel slug). */
export function seedNames(run: string): SeedNames {
  const h = createHash("sha256").update(run).digest("hex").slice(0, 8);
  return { streamer: `e2estreamer${h}`, viewer: `e2eviewer${h}`, amountCents: 1234 };
}

/** The ids the seed wrote, as the seed script prints them. */
export interface Seeded {
  streamer: string;
  viewer: string;
  channel: string;
  slug: string;
  costId: string;
  transactionId: string;
}

/**
 * JavaScript for `bun -e` in the published release's api container (its workspace is at /app).
 * It writes as the app role (DATABASE_URL), in one transaction, what the API's own handlers write:
 * two members with verified emails, the streamer's channel (signup creates it), a follow with the
 * follower count the follow handler keeps, and an infrastructure cost: the treasurer's
 * `cost.record` posting through the ledger package, with its infra_costs row. The triggers check
 * all of it. The HTTP signup itself would need an ALTCHA solution and a verification email this
 * host cannot receive, and the cost a treasurer's session.
 */
export function seedScript(names: SeedNames): string {
  const c = JSON.stringify(names);
  return `
const c = ${c};
const { createDb, schema, uuidv7 } = await import("/app/packages/db/src/index.ts");
const { post, infrastructureCost } = await import("/app/packages/ledger/src/index.ts");
const { eq } = await import("drizzle-orm");
const { db, close } = createDb({ url: process.env.DATABASE_URL, max: 1 });
try {
  const out = await db.transaction(async (tx) => {
    const streamer = uuidv7();
    const viewer = uuidv7();
    const channel = uuidv7();
    const costId = uuidv7();
    const member = (id, name) => ({ id, name, email: name + "@selfhost.test", emailVerified: true, username: name, birthDate: "1990-06-15" });
    await tx.insert(schema.users).values([member(streamer, c.streamer), member(viewer, c.viewer)]);
    await tx.insert(schema.channels).values({ id: channel, ownerId: streamer, slug: c.streamer, displayName: c.streamer });
    await tx.insert(schema.follows).values({ followerId: viewer, channelId: channel });
    // The follow handler's count; the channel is new, so it is 1.
    await tx.update(schema.channels).set({ followerCount: 1 }).where(eq(schema.channels.id, channel));
    const now = new Date();
    const currency = process.env.CURRENCY || "usd";
    const r = await post(tx, infrastructureCost({ infraCostId: costId, category: "hosting", provider: "manual", amountCents: c.amountCents, currency, occurredAt: now }));
    await tx.insert(schema.infraCosts).values({
      id: costId, periodStart: new Date(now.getTime() - 86400000), periodEnd: now, category: "hosting",
      description: "e2e seed", amountCents: c.amountCents, currency, recordedBy: streamer, ledgerTransactionId: r.transactionId,
    });
    return { streamer, viewer, channel, slug: c.streamer, costId, transactionId: r.transactionId };
  });
  console.log(JSON.stringify(out));
} finally {
  await close();
}
`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The seed script's last output line, checked: every id a UUID. */
export function parseSeeded(output: string): Seeded {
  const line = output.trim().split("\n").at(-1) ?? "";
  let v: Partial<Seeded>;
  try {
    v = JSON.parse(line) as Partial<Seeded>;
  } catch {
    throw new Error(`the seed printed no JSON: ${line.slice(0, 200)}`);
  }
  for (const k of ["streamer", "viewer", "channel", "costId", "transactionId"] as const)
    if (typeof v[k] !== "string" || !UUID.test(v[k])) throw new Error(`the seed printed no ${k} id`);
  if (typeof v.slug !== "string" || !/^[a-z0-9]+$/.test(v.slug)) throw new Error("the seed printed no slug");
  return v as Seeded;
}

/**
 * One row, `|`-separated, for psql in the Postgres container: the members, the channel's follower
 * count, the follow, the posting's entry count and sum (0: balanced) and its infra_costs row.
 * Only UUIDs from parseSeeded reach it.
 */
export function seedCheckSql(s: Seeded): string {
  for (const id of [s.streamer, s.viewer, s.channel, s.transactionId, s.costId])
    if (!UUID.test(id)) throw new Error(`not a UUID: ${id}`);
  return [
    "select",
    `(select count(*) from users where id in ('${s.streamer}', '${s.viewer}') and deleted_at is null),`,
    `(select follower_count from channels where id = '${s.channel}' and owner_id = '${s.streamer}'),`,
    `(select count(*) from follows where follower_id = '${s.viewer}' and channel_id = '${s.channel}'),`,
    `(select count(*) from ledger_entries where transaction_id = '${s.transactionId}'),`,
    `(select coalesce(sum(amount_cents), 0) from ledger_entries where transaction_id = '${s.transactionId}'),`,
    `(select count(*) from infra_costs where id = '${s.costId}' and ledger_transaction_id = '${s.transactionId}')`,
  ].join(" ");
}

/** What is wrong with seedCheckSql's row (empty: the data survived). */
export function seedProblems(row: string): string[] {
  const [users, followers, follows, entries, sum, costs] = row.trim().split("|");
  const want: [string, string | undefined, string][] = [
    ["both members", users, "2"],
    ["the channel's follower count", followers, "1"],
    ["the follow", follows, "1"],
    ["the posting's entries", entries, "2"],
    ["the posting's balance", sum, "0"],
    ["the infrastructure cost", costs, "1"],
  ];
  return want
    .filter(([, got, exp]) => got !== exp)
    .map(([what, got, exp]) => `${what}: ${got ?? "nothing"}, want ${exp}`);
}

/** psql in the bundled Postgres container (the owner over its socket, as selfhost.sh runs it), one unaligned row. */
export function psqlCommand(sql: string): string {
  return (
    "podman exec --user postgres commonair-postgres psql -X -q -v ON_ERROR_STOP=1 -U commonair -d commonair " +
    `-At -F '|' -c ${shellQuote(sql)}`
  );
}

/** Runs seedScript in the api container (base64 keeps it out of the host shell's quoting). */
export function seedInApi(inHost: InHost, names: SeedNames): Seeded {
  const b64 = Buffer.from(seedScript(names)).toString("base64");
  return parseSeeded(
    inHost(`podman exec -w /app/services/api commonair-api bun -e "$(printf %s ${b64} | base64 -d)"`, { user: true }),
  );
}

/** The data survived, in the database and through the public API (Caddy, its internal CA). */
export function checkSeeded(inHost: InHost, expectThat: Expect, s: Seeded, label: string, caFlag: string): void {
  const row = inHost(psqlCommand(seedCheckSql(s)), { user: true }).trim();
  const problems = seedProblems(row);
  expectThat(problems.length === 0, `${label}: the seeded data is intact (${problems.join("; ") || row})`);
  const body = inHost(`curl -sS --fail ${caFlag} https://selfhost.test/api/channels/${s.slug}`, { user: true });
  let followers: unknown;
  try {
    followers = (JSON.parse(body) as { followerCount?: unknown }).followerCount;
  } catch {
    followers = undefined;
  }
  expectThat(followers === 1, `${label}: GET /api/channels/${s.slug} shows its follower (${String(followers)})`);
}

// --- the flow e2e.ts runs -------------------------------------------------------------------

export interface PublishedInstall {
  tag: string;
  /** The downloads' directory as the host container sees it. */
  downloads: string;
  /** The e2e's own install flags (TLS, domain, contact, address, model). */
  extra: string;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Install tries; a try after the first happens only when a registry rate-limited a pull. */
  attempts?: number;
  baseMs?: number;
}

/** cosign, the verification, then the published release's own install, with its retries. */
export async function installPublished(inHost: InHost, expectThat: Expect, o: PublishedInstall): Promise<void> {
  const { version } = releaseTag(o.tag);
  const { sleep = (ms: number) => Bun.sleep(ms), attempts = 3, baseMs = 60_000 } = o;
  inHost(cosignInstallScript(hostArch()));
  const verified = inHost(verifyAndUnpackScript(o.downloads, o.tag));
  const problems = verificationProblems(verified, version);
  expectThat(
    problems.length === 0,
    `${o.tag} verifies as verifying.md says (cosign with the release workflow's identity and issuer, ` +
      `then sha256sum): ${problems.join("; ") || "ok"}`,
  );
  for (let i = 0; i < attempts; i++) {
    // A retry runs the same install over what the failed one left (--reinstall keeps its secrets).
    const out = inHost(publishedInstallCommand(o.tag, o.extra, i > 0));
    if (exitStatus(out) === 0) return;
    if (i < attempts - 1 && isRateLimited(out)) {
      const wait = backoffMs(i, baseMs);
      o.log(`the install of ${o.tag} hit a registry rate limit; retrying in ${wait / 1000} s`);
      await sleep(wait);
      continue;
    }
    throw new Error(`the published ${o.tag} did not install (try ${i + 1}):\n${out.slice(-3000)}`);
  }
}

/** The failure of an upgrade from a published release, worded as the blocker to record. */
export function upgradeBlocker(tag: string, to: string, outcome: UpgradeOutcome, output: string): string {
  const lines = [
    `upgrading from the published ${tag} to ${to} with ${tag}'s own selfhost.sh failed` +
      (outcome.rolledBack ? `, and it rolled back to ${tag}` : ""),
  ];
  if (outcome.unhealthy.length) lines.push(`not healthy: ${outcome.unhealthy.join(", ")}`);
  lines.push(output.trim().split("\n").slice(-40).join("\n"));
  return lines.join("\n");
}
