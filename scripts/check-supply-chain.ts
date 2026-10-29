// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The supply-chain gate (ADR 0022): exact pins, install cooldown, trusted install scripts,
 * known advisories, SHA-pinned actions and digest-pinned images. Needs the network for
 * `bun audit`; fails closed when the registry cannot be reached.
 *
 * `--advisories` runs only the advisory check, for the daily vulnerability scan: new advisories
 * land against code that has not changed, so a push-time check alone misses them.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  type AuditReport,
  type Finding,
  type Policy,
  checkAudit,
  checkBunfig,
  checkImages,
  checkManifest,
  checkTrusted,
  checkWorkflow,
  imageBearing,
} from "./supply-chain.ts";

const tracked = Bun.spawnSync(["git", "ls-files", "-z"]).stdout.toString().split("\0").filter(Boolean);
const read = (p: string) => readFileSync(p, "utf8");
const policy = JSON.parse(read("supply-chain.json")) as Policy;
const findings: Finding[] = [];
const advisoriesOnly = process.argv.includes("--advisories");

const manifests = advisoriesOnly ? [] : tracked.filter((p) => p === "package.json" || p.endsWith("/package.json"));
for (const p of manifests) findings.push(...checkManifest(p, JSON.parse(read(p))));
if (!advisoriesOnly) {
  findings.push(...checkTrusted("package.json", JSON.parse(read("package.json")), policy));
  findings.push(...checkBunfig("bunfig.toml", existsSync("bunfig.toml") ? read("bunfig.toml") : null));
}

const workflows = advisoriesOnly
  ? []
  : tracked.filter((p) => /^\.github\/(workflows\/.+|actions\/.+\/action)\.ya?ml$/.test(p));
for (const p of workflows) findings.push(...checkWorkflow(p, read(p)));

const imageFiles = advisoriesOnly ? [] : imageBearing(tracked).filter((p) => existsSync(p));
for (const p of imageFiles) findings.push(...checkImages(p, read(p)));

const audit = Bun.spawnSync(["bun", "audit", "--json"], { timeout: 120_000 });
const out = audit.stdout.toString().trim();
let report: AuditReport | null = null;
try {
  report = out === "" ? {} : (JSON.parse(out) as AuditReport);
} catch {
  report = null;
}
if (report === null || (audit.exitCode !== 0 && Object.keys(report).length === 0)) {
  console.error(`bun audit failed (exit ${audit.exitCode}); the advisory check needs the npm registry.`);
  console.error(audit.stderr.toString().trim());
  process.exit(1);
}
findings.push(...checkAudit(report, policy, new Date().toISOString().slice(0, 10)));

for (const f of findings) console.error(`✗ ${f.what}  ${f.reason}\n    ${f.where}`);
console.log(
  `check-supply-chain: ${manifests.length} manifests, ${workflows.length} workflows, ${imageFiles.length} image-bearing files, ${Object.keys(report).length} advisory packages`,
);
if (findings.length > 0) {
  console.error(`\n${findings.length} supply-chain violation(s). See docs/decisions/0022-supply-chain.md.`);
  process.exit(1);
}
