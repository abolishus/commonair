// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Vet an npm package BEFORE installing or upgrading it (ADR 0022).
 *
 *   bun scripts/vet-package.ts zod@4.6.7 some-new-lib
 *
 * Without a version it vets the `latest` dist-tag, or the newest version past the cooldown when
 * latest is too young. Fails on: a version younger than the cooldown, known vulnerabilities
 * (OSV), deprecation, or a non-OSI license. Warns on what needs a human look: install scripts,
 * no provenance attestation, a publisher who did not publish the previous version, a package
 * that is itself new, and low download counts (typosquat signals). It prints the exact
 * `bun add` to run. Transitive dependencies are covered after install by the same cooldown in
 * bunfig.toml and by `bun audit` in check-supply-chain.
 */
import { evaluate, licenseOf } from "./licenses.ts";
import { MIN_RELEASE_AGE_DAYS } from "./supply-chain.ts";

const DAY_MS = 86_400_000;

export interface VersionMeta {
  version: string;
  license?: unknown;
  licenses?: unknown;
  deprecated?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  dist?: { attestations?: unknown };
  _npmUser?: { name?: string };
}

export interface Packument {
  name: string;
  "dist-tags": Record<string, string>;
  time: Record<string, string>;
  versions: Record<string, VersionMeta>;
}

export interface Assessment {
  version: string;
  fails: string[];
  warns: string[];
  notes: string[];
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

/** Stable versions, newest publish first. */
function stableByTime(p: Packument): string[] {
  return Object.keys(p.versions)
    .filter((v) => SEMVER.test(v) && !SEMVER.exec(v)![4] && p.time[v])
    .sort((a, b) => Date.parse(p.time[b]!) - Date.parse(p.time[a]!));
}

/** The version to vet: the requested one, else latest, else the newest one past the cooldown. */
export function pickVersion(p: Packument, requested: string | undefined, now: number): string | undefined {
  if (requested) return requested;
  const latest = p["dist-tags"].latest;
  const old = (v: string) => now - Date.parse(p.time[v] ?? "") >= MIN_RELEASE_AGE_DAYS * DAY_MS;
  if (latest && old(latest)) return latest;
  return stableByTime(p).find(old) ?? latest;
}

export function assess(
  p: Packument,
  version: string,
  now: number,
  vulns: { id: string; summary?: string }[],
  weeklyDownloads: number | null,
): Assessment {
  const fails: string[] = [];
  const warns: string[] = [];
  const notes: string[] = [];
  const meta = p.versions[version];
  if (!meta) return { version, fails: [`${p.name}@${version} does not exist`], warns, notes };

  const published = Date.parse(p.time[version] ?? "");
  const ageDays = (now - published) / DAY_MS;
  if (!Number.isFinite(ageDays)) fails.push("no publish time in registry metadata");
  else if (ageDays < MIN_RELEASE_AGE_DAYS)
    fails.push(`published ${ageDays.toFixed(1)} days ago; the cooldown is ${MIN_RELEASE_AGE_DAYS} days`);
  else notes.push(`published ${Math.floor(ageDays)} days ago (${p.time[version]})`);

  for (const v of vulns) fails.push(`known vulnerability ${v.id}${v.summary ? `: ${v.summary}` : ""}`);
  if (meta.deprecated) fails.push(`deprecated: ${meta.deprecated}`);

  const license = licenseOf(meta) ?? "UNKNOWN";
  const verdict = evaluate(license);
  if (!verdict.ok) fails.push(`license ${license}: ${verdict.reason}`);
  else notes.push(`license ${license}`);

  const scripts = Object.keys(meta.scripts ?? {}).filter((s) => ["preinstall", "install", "postinstall"].includes(s));
  if (scripts.length > 0)
    warns.push(
      `declares ${scripts.join(", ")} (bun will not run it: trustedDependencies is empty). Read the script and check the package works without it`,
    );

  if (!meta.dist?.attestations) warns.push("no npm provenance attestation (cannot tie the tarball to a source commit)");

  const ordered = stableByTime(p).reverse();
  const idx = ordered.indexOf(version);
  const previous = idx > 0 ? p.versions[ordered[idx - 1]!] : undefined;
  const publisher = meta._npmUser?.name;
  if (previous && publisher && previous._npmUser?.name && previous._npmUser.name !== publisher)
    warns.push(
      `published by ${publisher}; the previous version ${previous.version} by ${previous._npmUser.name} (account takeover signal)`,
    );

  const createdDays = (now - Date.parse(p.time.created ?? "")) / DAY_MS;
  if (Number.isFinite(createdDays) && createdDays < 90)
    warns.push(`the package itself is only ${Math.floor(createdDays)} days old`);
  if (weeklyDownloads !== null && weeklyDownloads < 1000)
    warns.push(`${weeklyDownloads} downloads last week (check the name for typosquatting)`);

  notes.push(`${Object.keys(meta.dependencies ?? {}).length} direct dependencies`);
  return { version, fails, warns, notes };
}

/** "name", "name@1.2.3", "@scope/name", "@scope/name@1.2.3" */
export function parseSpec(spec: string): { name: string; version?: string } {
  const at = spec.indexOf("@", 1);
  return at === -1 ? { name: spec } : { name: spec.slice(0, at), version: spec.slice(at + 1) || undefined };
}

async function vet(spec: string): Promise<boolean> {
  const { name, version: requested } = parseSpec(spec);
  const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
  if (!res.ok) {
    console.error(`✗ ${name}: registry returned HTTP ${res.status}`);
    return false;
  }
  const p = (await res.json()) as Packument;
  const now = Date.now();
  const version = pickVersion(p, requested, now);
  if (!version) {
    console.error(`✗ ${name}: no version to vet`);
    return false;
  }
  const osv = await fetch("https://api.osv.dev/v1/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ package: { name, ecosystem: "npm" }, version }),
  });
  if (!osv.ok) throw new Error(`OSV returned HTTP ${osv.status}; refusing to vet without advisories`);
  const vulns = ((await osv.json()) as { vulns?: { id: string; summary?: string }[] }).vulns ?? [];
  const dl = await fetch(`https://api.npmjs.org/downloads/point/last-week/${name}`);
  const weekly = dl.ok ? (((await dl.json()) as { downloads?: number }).downloads ?? null) : null;

  const a = assess(p, version, now, vulns, weekly);
  console.log(
    `\n${a.fails.length ? "✗" : "✓"} ${name}@${a.version}${requested ? "" : ` (latest is ${p["dist-tags"].latest})`}`,
  );
  for (const f of a.fails) console.log(`  FAIL  ${f}`);
  for (const w of a.warns) console.log(`  WARN  ${w}`);
  for (const n of a.notes) console.log(`        ${n}`);
  if (!a.fails.length) console.log(`  next: bun add --exact ${name}@${a.version}  (then bun run verify)`);
  return a.fails.length === 0;
}

if (import.meta.main) {
  const specs = process.argv.slice(2);
  if (specs.length === 0) {
    console.error("usage: bun scripts/vet-package.ts <name>[@version] ...");
    process.exit(2);
  }
  let ok = true;
  for (const s of specs) ok = (await vet(s)) && ok;
  process.exit(ok ? 0 : 1);
}
