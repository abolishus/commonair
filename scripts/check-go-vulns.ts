// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * govulncheck over the relay, with the same dated exceptions as npm advisories (ADR 0022).
 * govulncheck is run at a pinned version through the Go module proxy, which checks it against
 * the checksum database.
 */
import { readFileSync } from "node:fs";
import { type GoFinding, type Policy, checkGoVulns, parseJsonStream } from "./supply-chain.ts";

const GOVULNCHECK = "golang.org/x/vuln/cmd/govulncheck@v1.9.0";

const run = Bun.spawnSync(["go", "run", GOVULNCHECK, "-format", "json", "./..."], { cwd: "relay", timeout: 240_000 });
if (run.exitCode !== 0) {
  console.error(`govulncheck failed (exit ${run.exitCode}); it needs the Go vulnerability database.`);
  console.error(run.stderr.toString().trim());
  process.exit(1);
}
const found = parseJsonStream(run.stdout.toString()).flatMap((m) =>
  m && typeof m === "object" && "finding" in m ? [(m as { finding: GoFinding }).finding] : [],
);
const policy = JSON.parse(readFileSync("supply-chain.json", "utf8")) as Policy;
const findings = checkGoVulns(found, policy, new Date().toISOString().slice(0, 10));
for (const f of findings) console.error(`✗ ${f.what}  ${f.reason}\n    ${f.where}`);
console.log(`check-go-vulns: ${found.length} raw findings, ${findings.length} violation(s)`);
if (findings.length > 0) process.exit(1);
