// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fails on any dependency whose license is not on the OSI allowlist.
 * Covers: every installed npm package (all workspaces, dev included), the Go
 * relay's modules, and every container image referenced by compose.yaml.
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
      // Our own workspace packages are AGPL by construction (checked by reuse lint).
      if (pkg.name.startsWith("@commonair/") || pkg.name === "commonair") continue;
      const key = `${pkg.name}@${pkg.version}`;
      if (seen.has(key)) continue;
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

if (import.meta.main) {
  const npm = checkNpm(["."]);
  const images = checkImages("compose.yaml", "infra/image-licenses.json");
  const go = checkGo("relay");
  const findings = [...npm.findings, ...images.findings, ...go.findings];
  for (const f of findings)
    console.error(`✗ ${f.name}${f.version ? `@${f.version}` : ""} [${f.license}] ${f.reason}\n    ${f.where}`);
  console.log(`check-licenses: ${npm.checked} npm packages, ${images.checked} images, ${go.checked} Go modules`);
  if (findings.length > 0) {
    console.error(`\n${findings.length} license violation(s). See docs/decisions/0002-license-policy.md.`);
    process.exit(1);
  }
}
