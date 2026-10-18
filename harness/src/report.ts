// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Run reports: one JSON document plus a human summary, written to `harness/reports/`. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatDuration } from "./metrics.ts";
import type { Profile, ScenarioResult } from "./scenario.ts";

export const DEFAULT_REPORT_DIR = fileURLToPath(new URL("../reports", import.meta.url));

export interface RunReport {
  runId: string;
  command: string;
  profile: Profile;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  host: { platform: string; arch: string; bun: string; ffmpeg: string | null };
  targets: Record<string, string>;
  scenarios: ScenarioResult[];
  summary: { passed: number; failed: number; skipped: number };
  ok: boolean;
}

export function summarizeResults(results: readonly ScenarioResult[]): RunReport["summary"] {
  return {
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
  };
}

const MARK = { passed: "PASS", failed: "FAIL", skipped: "SKIP" } as const;

function formatValue(value: number, unit?: string): string {
  if (unit === "ms") return formatDuration(value);
  if (unit === "bytes") {
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${value} B`;
  }
  const n = Number.isInteger(value) ? String(value) : value.toFixed(3);
  return unit ? `${n} ${unit}` : n;
}

/** Human-readable summary (what the CLI prints and writes next to the JSON). */
export function formatHuman(report: RunReport): string {
  const lines: string[] = [];
  lines.push(`harness ${report.command} — run ${report.runId} (${report.profile} profile)`);
  lines.push(`started ${report.startedAt}, took ${formatDuration(report.durationMs)}`);
  lines.push("");
  for (const s of report.scenarios) {
    lines.push(
      `${MARK[s.status]}  ${s.name}  ${formatDuration(s.durationMs)}${s.skipReason ? `  (${s.skipReason})` : ""}`,
    );
    for (const step of s.steps) {
      lines.push(
        `        ${step.status === "passed" ? "✓" : "✗"} ${step.name}  ${formatDuration(step.durationMs)}${step.error ? `  — ${step.error}` : ""}`,
      );
    }
    for (const a of s.assertions.filter((x) => !x.passed)) {
      lines.push(`        ✗ ${a.name}${a.details === undefined ? "" : `  ${JSON.stringify(a.details)}`}`);
    }
    const passedAssertions = s.assertions.filter((a) => a.passed).length;
    if (s.assertions.length > 0) lines.push(`        assertions: ${passedAssertions}/${s.assertions.length} passed`);
    const metricNames = Object.keys(s.metrics);
    if (metricNames.length > 0) {
      const width = Math.max(...metricNames.map((n) => n.length));
      for (const name of metricNames) {
        const m = s.metrics[name];
        if (m) lines.push(`        ${name.padEnd(width)}  ${formatValue(m.value, m.unit)}`);
      }
    }
    if (s.error) lines.push(`        error: ${s.error}`);
  }
  lines.push("");
  const { passed, failed, skipped } = report.summary;
  lines.push(`${report.ok ? "OK" : "FAILED"}: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  return lines.join("\n");
}

/** File-system-safe timestamp for report names. */
export function reportStem(report: Pick<RunReport, "startedAt" | "runId" | "command">): string {
  return `${report.startedAt.replace(/[:.]/g, "-")}-${report.command}-${report.runId}`;
}

/** Write `<stem>.json` and `<stem>.txt` (or the JSON to `jsonPath`), plus `latest.json`. */
export function writeReport(
  report: RunReport,
  opts: { dir?: string; jsonPath?: string } = {},
): { json: string; text: string } {
  const dir = opts.dir ?? DEFAULT_REPORT_DIR;
  const json = opts.jsonPath ?? join(dir, `${reportStem(report)}.json`);
  const text = json.replace(/\.json$/i, "") + ".txt";
  mkdirSync(dirname(json), { recursive: true });
  const body = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(json, body);
  writeFileSync(text, `${formatHuman(report)}\n`);
  if (!opts.jsonPath) writeFileSync(join(dir, "latest.json"), body);
  return { json, text };
}
