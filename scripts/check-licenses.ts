// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fails on any dependency whose license is not on the OSI allowlist.
 * Covers: every installed npm package (all workspaces, dev included), the Go
 * relay's modules, every container image referenced by compose.yaml, and every
 * OpenTofu provider in a .terraform.lock.hcl under infra/tofu.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXCEPTIONS, evaluate, licenseOf } from "./licenses.ts";

interface Finding {
  name: string;
  version: string;
  license: string;
  reason: string;
  where: string;
}

function* packageJsonFiles(dir: string, depth = 0): Generator<string> {
  if (depth > 12 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === ".cache") continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // dangling symlink
    }
    if (!st.isDirectory()) continue;
    if (entry.startsWith("@")) {
      yield* packageJsonFiles(full, depth + 1);
      continue;
    }
    if (entry === ".bun") {
      for (const store of readdirSync(full)) yield* packageJsonFiles(join(full, store, "node_modules"), depth + 1);
      continue;
    }
    const pj = join(full, "package.json");
    if (existsSync(pj)) yield pj;
    const nested = join(full, "node_modules");
    if (existsSync(nested)) yield* packageJsonFiles(nested, depth + 1);
  }
}

/** Our packages that are not AGPL-3.0-or-later (ADR 0035: the SDK is Apache-2.0, so apps of any licence can embed it). */
export const OWN_LICENSES: Record<string, string> = { "@commonair/sdk": "Apache-2.0" };

export function checkNpm(roots: string[]): { checked: number; findings: Finding[] } {
  const seen = new Map<string, Finding | null>();
  for (const root of roots) {
    for (const pj of packageJsonFiles(join(root, "node_modules"))) {
      let pkg: {
        name?: string;
        version?: string;
        license?: unknown;
        licenses?: unknown;
        private?: boolean;
      };
      try {
        pkg = JSON.parse(readFileSync(pj, "utf8"));
      } catch {
        continue;
      }
      if (!pkg.name || !pkg.version) continue;
      const key = `${pkg.name}@${pkg.version}`;
      if (seen.has(key)) continue;
      // Our own workspace packages: AGPL, except the SDK (Apache-2.0, ADR 0035). Their files'
      // headers are checked by reuse lint; this checks what each package.json declares.
      if (pkg.name.startsWith("@commonair/") || pkg.name === "commonair") {
        const expected = OWN_LICENSES[pkg.name] ?? "AGPL-3.0-or-later";
        const declared = licenseOf(pkg) ?? "UNKNOWN";
        seen.set(
          key,
          declared === expected
            ? null
            : {
                name: pkg.name,
                version: pkg.version,
                license: declared,
                reason: `own package must be ${expected}`,
                where: pj,
              },
        );
        continue;
      }
      const license = licenseOf(pkg) ?? "UNKNOWN";
      const exception = EXCEPTIONS[pkg.name];
      if (exception) {
        seen.set(
          key,
          exception.license === license
            ? null
            : {
                name: pkg.name,
                version: pkg.version,
                license,
                reason: `exception pins ${exception.license}`,
                where: pj,
              },
        );
        continue;
      }
      const verdict = evaluate(license);
      seen.set(
        key,
        verdict.ok ? null : { name: pkg.name, version: pkg.version, license, reason: verdict.reason, where: pj },
      );
    }
  }
  return {
    checked: seen.size,
    findings: [...seen.values()].filter((f): f is Finding => f !== null),
  };
}

/** Container images must be listed in infra/image-licenses.json with an allowed license. */
export function checkImages(composePath: string, registryPath: string): { checked: number; findings: Finding[] } {
  if (!existsSync(composePath)) return { checked: 0, findings: [] };
  const images = [...readFileSync(composePath, "utf8").matchAll(/^\s*image:\s*["']?([^"'\s#]+)/gm)].map((m) => m[1]!);
  const registry: Record<string, { license: string; source: string }> = existsSync(registryPath)
    ? JSON.parse(readFileSync(registryPath, "utf8"))
    : {};
  const findings: Finding[] = [];
  for (const ref of new Set(images)) {
    if (ref.includes("${")) continue; // our own built images, templated by tag
    const repo = ref.replace(/@sha256:.*$/, "").replace(/:[^/:]+$/, "");
    if (!/^[a-z0-9.-]+\.[a-z]+(:\d+)?\//.test(repo)) {
      findings.push({
        name: ref,
        version: "",
        license: "",
        reason: "image name must be fully qualified",
        where: composePath,
      });
      continue;
    }
    const entry = registry[repo];
    if (!entry) {
      findings.push({
        name: repo,
        version: "",
        license: "UNKNOWN",
        reason: "not listed in infra/image-licenses.json",
        where: composePath,
      });
      continue;
    }
    const verdict = evaluate(entry.license);
    if (!verdict.ok)
      findings.push({
        name: repo,
        version: "",
        license: entry.license,
        reason: verdict.reason,
        where: registryPath,
      });
  }
  return { checked: new Set(images).size, findings };
}

/** The relay must stay stdlib-only unless a module is added to relay/module-licenses.json. */
export function checkGo(relayDir: string): { checked: number; findings: Finding[] } {
  if (!existsSync(join(relayDir, "go.mod"))) return { checked: 0, findings: [] };
  const out = Bun.spawnSync(["go", "list", "-m", "-f", "{{.Path}} {{.Version}} {{.Main}}", "all"], {
    cwd: relayDir,
  });
  if (out.exitCode !== 0) throw new Error(`go list failed: ${out.stderr.toString()}`);
  const registryPath = join(relayDir, "module-licenses.json");
  const registry: Record<string, string> = existsSync(registryPath)
    ? JSON.parse(readFileSync(registryPath, "utf8"))
    : {};
  const findings: Finding[] = [];
  let checked = 0;
  for (const line of out.stdout.toString().trim().split("\n")) {
    const [path, version, main] = line.split(" ");
    if (!path || main === "true") continue;
    checked++;
    const license = registry[path];
    const verdict = license
      ? evaluate(license)
      : { ok: false as const, reason: "not listed in relay/module-licenses.json" };
    if (!verdict.ok)
      findings.push({
        name: path,
        version: version ?? "",
        license: license ?? "UNKNOWN",
        reason: verdict.reason,
        where: registryPath,
      });
  }
  return { checked, findings };
}

type ProviderRegistry = Record<string, { license: string; source: string }>;

function isProviderRegistry(value: unknown): value is ProviderRegistry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "license" in entry &&
      typeof entry.license === "string" &&
      "source" in entry &&
      typeof entry.source === "string",
  );
}

function* lockFiles(dir: string, depth = 0): Generator<string> {
  if (depth > 8 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    // `tofu init` downloads providers into .terraform; only the committed lock files count.
    if (entry === ".terraform") continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // dangling symlink
    }
    if (st.isDirectory()) yield* lockFiles(full, depth + 1);
    else if (entry === ".terraform.lock.hcl") yield full;
  }
}

/** Every provider pinned in a lock file must be listed in infra/tofu/provider-licenses.json. */
export function checkTofu(tofuDir: string, registryPath: string): { checked: number; findings: Finding[] } {
  if (!existsSync(tofuDir)) return { checked: 0, findings: [] };
  const findings: Finding[] = [];
  let registry: ProviderRegistry = {};
  if (existsSync(registryPath)) {
    const parsed: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
    if (!isProviderRegistry(parsed))
      return {
        checked: 0,
        findings: [
          {
            name: registryPath,
            version: "",
            license: "",
            reason: "must map each provider address to { license: string, source: string }",
            where: registryPath,
          },
        ],
      };
    registry = parsed;
  }
  const seen = new Set<string>();
  for (const lock of lockFiles(tofuDir)) {
    const text = readFileSync(lock, "utf8");
    for (const match of text.matchAll(/^provider\s+"([^"]+)"\s*\{[^}]*?^\s*version\s*=\s*"([^"]+)"/gm)) {
      const [, address, version] = match;
      if (address === undefined || version === undefined) continue;
      seen.add(`${address}@${version}`);
      const entry = registry[address];
      const verdict = entry
        ? evaluate(entry.license)
        : { ok: false as const, reason: "not listed in infra/tofu/provider-licenses.json" };
      if (!verdict.ok)
        findings.push({
          name: address,
          version,
          license: entry?.license ?? "UNKNOWN",
          reason: verdict.reason,
          where: lock,
        });
    }
  }
  return { checked: seen.size, findings };
}

if (import.meta.main) {
  const npm = checkNpm(["."]);
  const images = checkImages("compose.yaml", "infra/image-licenses.json");
  const go = checkGo("relay");
  const tofu = checkTofu("infra/tofu", "infra/tofu/provider-licenses.json");
  const findings = [...npm.findings, ...images.findings, ...go.findings, ...tofu.findings];
  for (const f of findings)
    console.error(`✗ ${f.name}${f.version ? `@${f.version}` : ""} [${f.license}] ${f.reason}\n    ${f.where}`);
  console.log(
    `check-licenses: ${npm.checked} npm packages, ${images.checked} images, ${go.checked} Go modules, ${tofu.checked} OpenTofu providers`,
  );
  if (findings.length > 0) {
    console.error(`\n${findings.length} license violation(s). See docs/decisions/0002-license-policy.md.`);
    process.exit(1);
  }
}
