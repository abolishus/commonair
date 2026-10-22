// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Job summaries for CI, so a pull request shows what passed or failed without opening logs.
 *
 *   bun scripts/release/ci-summary.ts verify <verify.log>   → the verify summary as Markdown
 *   NEEDS_JSON='${{ toJSON(needs) }}' bun scripts/release/ci-summary.ts needs
 *       → a table of job results; exits 1 if any job failed or was cancelled (the `ci-ok` gate)
 *
 * Output goes to $GITHUB_STEP_SUMMARY when set, and to stdout.
 */
import { appendFileSync, readFileSync } from "node:fs";

// oxlint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const ANSI = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** The verify gate's own summary block ("verify summary" to the RED/GREEN line) as Markdown. */
export function verifySummary(log: string): string {
  const lines = stripAnsi(log).split("\n");
  const start = lines.findIndex((l) => l.trim() === "verify summary");
  if (start < 0)
    return "### verify\n\nThe gate did not reach its summary (it crashed or timed out); see the log artifact.\n";
  const rows: string[] = [];
  let verdict = "";
  for (const l of lines.slice(start + 1)) {
    const m = /^\s+([✓✗–])\s+(.+?)\s+(skipped|\d+(?:\.\d+)?s(?: \(timed out\))?)\s*$/.exec(l);
    if (m) {
      const [, mark, name, time] = m;
      const status = mark === "✓" ? "passed" : mark === "✗" ? "**failed**" : "skipped";
      rows.push(`| ${name} | ${status} | ${time} |`);
    } else if (/^(RED|GREEN) in /.test(l.trim())) {
      verdict = l.trim();
      break;
    }
  }
  return ["### verify", "", "| Step | Result | Time |", "| --- | --- | --- |", ...rows, "", verdict, ""].join("\n");
}

export interface NeedResult {
  result: string;
}

/** A Markdown table of job results and whether the aggregate passes (skipped jobs are fine). */
export function needsSummary(needs: Record<string, NeedResult>): { ok: boolean; markdown: string } {
  const entries = Object.entries(needs).sort(([a], [b]) => a.localeCompare(b));
  const bad = entries.filter(([, n]) => n.result === "failure" || n.result === "cancelled");
  const rows = entries.map(
    ([job, n]) =>
      `| ${job} | ${n.result === "success" ? "passed" : n.result === "skipped" ? "skipped" : `**${n.result}**`} |`,
  );
  const verdict = bad.length === 0 ? "All required jobs passed." : `Failed: ${bad.map(([j]) => j).join(", ")}.`;
  return {
    ok: bad.length === 0,
    markdown: ["### CI", "", "| Job | Result |", "| --- | --- |", ...rows, "", verdict, ""].join("\n"),
  };
}

function emit(markdown: string): void {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) appendFileSync(target, markdown);
  process.stdout.write(markdown);
}

if (import.meta.main) {
  const [cmd, file] = process.argv.slice(2);
  if (cmd === "verify" && file) {
    let log = "";
    try {
      log = readFileSync(file, "utf8");
    } catch {
      log = "";
    }
    emit(verifySummary(log));
  } else if (cmd === "needs") {
    const { ok, markdown } = needsSummary(JSON.parse(process.env.NEEDS_JSON ?? "{}") as Record<string, NeedResult>);
    emit(markdown);
    process.exit(ok ? 0 : 1);
  } else {
    console.error("usage: ci-summary.ts verify <log> | needs");
    process.exit(2);
  }
}
