// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Supply-chain policy (ADR 0022). Pure checks, so they can be unit tested; the gate that runs
 * them over the repository is scripts/check-supply-chain.ts.
 *
 * - npm: every dependency spec is an exact version (or workspace:/catalog:), never a range,
 *   tag, git URL or tarball, so nothing moves without a lockfile diff someone reviewed.
 * - bun: installs refuse versions younger than the cooldown, and `bun add` saves exact pins.
 * - Lifecycle scripts: only packages named in supply-chain.json may run install scripts.
 * - Advisories: `bun audit` and the relay's govulncheck must be clean apart from dated,
 *   reasoned exceptions.
 * - GitHub Actions: pinned to a full commit SHA (tags are mutable).
 * - Third-party container images: pinned to a digest (tags are mutable).
 */

export const MIN_RELEASE_AGE_DAYS = 7;
const DAY_S = 86_400;

export interface Finding {
  where: string;
  what: string;
  reason: string;
}

export interface AdvisoryException {
  /** npm (the default): a GHSA id from `bun audit`. go: a GO-YYYY-NNNN id from govulncheck. */
  ecosystem?: "npm" | "go";
  /** e.g. GHSA-67mh-4wv8-2f99 or GO-2026-6809. */
  id: string;
  /** npm package name, or Go module path ("stdlib" for the standard library). */
  package: string;
  /** Why it is acceptable for now: reachability, exposure, the upstream fix being waited on. */
  reason: string;
  /** ISO date (YYYY-MM-DD). After it the exception fails the gate and must be re-reviewed. */
  expires: string;
}

export interface Policy {
  advisoryExceptions: AdvisoryException[];
  /** Packages allowed to run install scripts, with the reason they need to. */
  trustedDependencies: Record<string, string>;
}

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** Why a package.json dependency spec is not an acceptable pin, or null when it is. */
export function specProblem(spec: string): string | null {
  if (spec.startsWith("workspace:")) return null;
  if (spec === "catalog:" || /^catalog:[\w-]+$/.test(spec)) return null;
  if (spec.startsWith("npm:")) {
    const at = spec.lastIndexOf("@");
    if (at <= "npm:".length) return "npm: alias without a version";
    return specProblem(spec.slice(at + 1));
  }
  if (EXACT.test(spec)) return null;
  if (/^(git|github|gitlab|bitbucket)[:+]|^https?:|^file:|^link:|\.tgz$/.test(spec))
    return "git, URL, file and tarball sources bypass the registry, its advisories and the cooldown";
  return "not an exact version (ranges and tags let a release land without review)";
}

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/** Checks dependency specs, plus the root's catalog and overrides, in one package.json. */
export function checkManifest(path: string, pkg: Record<string, unknown>): Finding[] {
  const findings: Finding[] = [];
  const check = (field: string, deps: unknown) => {
    if (!deps || typeof deps !== "object") return;
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      const problem = typeof spec === "string" ? specProblem(spec) : "spec is not a string";
      if (problem) findings.push({ where: `${path} ${field}`, what: `${name}@${String(spec)}`, reason: problem });
    }
  };
  for (const field of DEP_FIELDS) check(field, pkg[field]);
  check("catalog", pkg.catalog);
  check("overrides", pkg.overrides);
  // Named catalogs: { catalogs: { name: { pkg: spec } } }
  if (pkg.catalogs && typeof pkg.catalogs === "object")
    for (const [name, deps] of Object.entries(pkg.catalogs as Record<string, unknown>)) check(`catalogs.${name}`, deps);
  return findings;
}

/**
 * Bun runs install scripts for its built-in list of popular packages unless trustedDependencies
 * is set, so the root must set it explicitly, and only to packages the policy names.
 */
export function checkTrusted(path: string, pkg: Record<string, unknown>, policy: Policy): Finding[] {
  const trusted = pkg.trustedDependencies;
  if (!Array.isArray(trusted))
    return [
      {
        where: path,
        what: "trustedDependencies",
        reason: "must be set (an empty list is fine); otherwise bun trusts its default list",
      },
    ];
  return trusted
    .filter((name) => typeof name !== "string" || !policy.trustedDependencies[name])
    .map((name) => ({
      where: path,
      what: `trustedDependencies: ${String(name)}`,
      reason: "not listed with a reason in supply-chain.json trustedDependencies",
    }));
}

export function checkBunfig(path: string, text: string | null): Finding[] {
  if (text === null) return [{ where: path, what: "bunfig.toml", reason: "missing" }];
  let config: { install?: { exact?: unknown; minimumReleaseAge?: unknown } };
  try {
    config = Bun.TOML.parse(text) as typeof config;
  } catch (e) {
    return [{ where: path, what: "bunfig.toml", reason: `does not parse: ${(e as Error).message}` }];
  }
  const findings: Finding[] = [];
  if (config.install?.exact !== true)
    findings.push({ where: path, what: "[install] exact", reason: "must be true so `bun add` saves exact pins" });
  const age = config.install?.minimumReleaseAge;
  if (typeof age !== "number" || age < MIN_RELEASE_AGE_DAYS * DAY_S)
    findings.push({
      where: path,
      what: "[install] minimumReleaseAge",
      reason: `must be at least ${MIN_RELEASE_AGE_DAYS * DAY_S} (${MIN_RELEASE_AGE_DAYS} days, in seconds)`,
    });
  return findings;
}

/** `uses:` references in a workflow that are not pinned to a full commit SHA. */
export function checkWorkflow(path: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of text.matchAll(/^\s*-?\s*uses:\s*["']?([^"'\s#]+)/gm)) {
    const ref = m[1]!;
    if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
    if (!/@[0-9a-f]{40}$/.test(ref))
      findings.push({
        where: path,
        what: ref,
        reason: "action must be pinned to a full commit SHA (# vX.Y.Z comment)",
      });
  }
  return findings;
}

const REGISTRIES = [
  "docker.io",
  "ghcr.io",
  "quay.io",
  "gcr.io",
  "registry.k8s.io",
  "mcr.microsoft.com",
  "public.ecr.aws",
];
/** Images we build and publish ourselves; pinned by our own release process instead. */
const OWN_PREFIXES = ["ghcr.io/abolishus/", "localhost/"];

const IMAGE_RE = new RegExp(
  String.raw`(?:${REGISTRIES.map((r) => r.replaceAll(".", "\\.")).join("|")})/[a-z0-9._-]+(?:/[a-z0-9._-]+)+(?::[\w.-]+)?(?:@sha256:[0-9a-f]{64})?`,
  "g",
);

/**
 * Tracked files an image can be pulled from: compose, Containerfiles, quadlets, deploy config,
 * tests. Docs and briefs only mention images; scripts/tests holds the checker's fixtures.
 */
export function imageBearing(paths: string[]): string[] {
  return paths.filter(
    (p) =>
      /(\.ya?ml|\.ts|\.container|(^|\/)Containerfile[^/]*|\.Containerfile)$/.test(p) &&
      !/^(docs|\.claude|scripts\/tests)\//.test(p),
  );
}

export interface ImageRef {
  ref: string;
  line: number;
}

/** Third-party image references in a file, skipping comment lines. */
export const isCommentLine = (line: string) => /^\s*(#|\/\/|\*|\/\*)/.test(line);

export function imageRefs(text: string): ImageRef[] {
  const refs: ImageRef[] = [];
  text.split("\n").forEach((line, i) => {
    if (isCommentLine(line)) return;
    for (const m of line.matchAll(IMAGE_RE))
      if (!OWN_PREFIXES.some((p) => m[0].startsWith(p))) refs.push({ ref: m[0], line: i + 1 });
  });
  return refs;
}

export function checkImages(path: string, text: string): Finding[] {
  return imageRefs(text)
    .filter(({ ref }) => !/:[\w.-]+@sha256:[0-9a-f]{64}$/.test(ref))
    .map(({ ref, line }) => ({
      where: `${path}:${line}`,
      what: ref,
      reason: "image must be pinned as name:tag@sha256:<digest> (run bun scripts/pin-images.ts --write)",
    }));
}

/** The shape of `bun audit --json`: package name → advisories. */
export type AuditReport = Record<string, { url?: string; title?: string; severity?: string; id?: number }[]>;

function ghsaOf(url: string | undefined): string | undefined {
  return url?.match(/GHSA(-[a-z0-9]{4}){3}/i)?.[0];
}

interface Hit {
  package: string;
  id: string | undefined;
  label: string;
  title: string;
}

/** Hits not covered by a live exception, expired exceptions, and exceptions nothing matched. */
function applyExceptions(hits: Hit[], exceptions: AdvisoryException[], source: string, today: string): Finding[] {
  const findings: Finding[] = [];
  const used = new Set<AdvisoryException>();
  for (const h of hits) {
    const exception = exceptions.find((e) => e.id === h.id && e.package === h.package);
    if (!exception) {
      findings.push({
        where: source,
        what: h.label,
        reason: `${h.title}; upgrade, override, or add a dated exception with a reason to supply-chain.json`,
      });
      continue;
    }
    if (used.has(exception)) continue;
    used.add(exception);
    if (exception.expires < today)
      findings.push({
        where: "supply-chain.json",
        what: `${exception.package} ${exception.id}`,
        reason: `exception expired on ${exception.expires}: fix it or re-review and extend`,
      });
  }
  for (const e of exceptions)
    if (!used.has(e))
      findings.push({
        where: "supply-chain.json",
        what: `${e.package} ${e.id}`,
        reason: "exception no longer matches any advisory: remove it",
      });
  return findings;
}

export function checkAudit(report: AuditReport, policy: Policy, today: string): Finding[] {
  const hits = Object.entries(report).flatMap(([pkg, advisories]) =>
    advisories.map((a) => {
      const id = ghsaOf(a.url);
      return {
        package: pkg,
        id,
        label: `${pkg} ${id ?? a.id ?? "?"} (${a.severity ?? "unknown"})`,
        title: a.title ?? "advisory",
      };
    }),
  );
  const npm = policy.advisoryExceptions.filter((e) => (e.ecosystem ?? "npm") === "npm");
  return applyExceptions(hits, npm, "bun audit", today);
}

/** One `finding` message from `govulncheck -format json`. */
export interface GoFinding {
  osv: string;
  fixed_version?: string;
  trace: { module: string; version?: string; package?: string; function?: string }[];
}

/**
 * Only findings whose trace reaches a vulnerable function count, as in govulncheck's default
 * text mode: a vulnerable module or package that is imported but never called is not exposure.
 */
export function checkGoVulns(found: GoFinding[], policy: Policy, today: string): Finding[] {
  const reached = new Map<string, Hit>();
  for (const f of found) {
    const top = f.trace[0];
    if (!top?.function) continue;
    reached.set(`${top.module} ${f.osv}`, {
      package: top.module,
      id: f.osv,
      label: `${top.module}@${top.version ?? "?"} ${f.osv}`,
      title: `reachable via ${top.package ?? top.module}.${top.function}${f.fixed_version ? `, fixed in ${f.fixed_version}` : ""}`,
    });
  }
  const go = policy.advisoryExceptions.filter((e) => e.ecosystem === "go");
  return applyExceptions([...reached.values()], go, "govulncheck (relay)", today);
}

/** govulncheck's JSON output is a stream of pretty-printed objects, not an array or NDJSON. */
export function parseJsonStream(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" && depth++ === 0) start = i;
    else if (c === "}" && --depth === 0) out.push(JSON.parse(text.slice(start, i + 1)));
  }
  return out;
}
