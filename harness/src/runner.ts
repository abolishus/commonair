// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Scenario runner: checks each scenario's needs, runs it with a deadline and an abort signal,
 * records steps/assertions/metrics, always runs its cleanups, and stops any stray child process
 * before the next scenario.
 */
import type { Logger } from "@commonair/observability";
import type { HarnessEnv } from "./env.ts";
import { probeFfmpeg } from "./ffmpeg.ts";
import { Platform } from "./platform.ts";
import { stopAll } from "./process.ts";
import { type RunReport, summarizeResults } from "./report.ts";
import {
  AssertionFailure,
  type Need,
  PROPRIETARY_NEEDS,
  type Profile,
  type Scenario,
  type ScenarioContext,
  ScenarioRecorder,
  type ScenarioResult,
} from "./scenario.ts";

export const DEFAULT_SCENARIO_TIMEOUT_MS = 10 * 60_000;

export type NeedsVerdict = { run: true } | { run: false; status: "skipped" | "failed"; reason: string };

/**
 * Decide whether a scenario can run. Under `no-proprietary`, needing a vendor adapter means
 * "skip" (the profile is about running without them). Otherwise an unreachable need fails the
 * scenario, unless `skipUnavailable` is set.
 */
export async function evaluateNeeds(
  needs: readonly Need[],
  profile: Profile,
  probe: (need: Need) => Promise<string | null>,
  skipUnavailable = false,
): Promise<NeedsVerdict> {
  if (profile === "no-proprietary") {
    const vendor = needs.filter((n) => PROPRIETARY_NEEDS.includes(n));
    if (vendor.length > 0)
      return { run: false, status: "skipped", reason: `needs ${vendor.join(", ")} (no-proprietary profile)` };
  }
  const problems: string[] = [];
  for (const need of needs) {
    const problem = await probe(need);
    if (problem) problems.push(`${need}: ${problem}`);
  }
  if (problems.length === 0) return { run: true };
  return { run: false, status: skipUnavailable ? "skipped" : "failed", reason: `unmet needs — ${problems.join("; ")}` };
}

export interface RunOptions {
  command: string;
  profile: Profile;
  env: HarnessEnv;
  log: Logger;
  params?: Record<string, string>;
  skipUnavailable?: boolean;
  runId?: string;
  /** Inject a platform (tests); otherwise one is created and closed by the run. */
  platform?: Platform;
  signal?: AbortSignal;
}

export function newRunId(): string {
  return `${Date.now().toString(36)}${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`;
}

function makeContext(
  scenario: Scenario,
  rec: ScenarioRecorder,
  platform: Platform,
  opts: RunOptions & { runId: string },
  signal: AbortSignal,
): ScenarioContext {
  const log = opts.log.child({ scenario: scenario.name });
  const params = opts.params ?? {};
  return {
    name: scenario.name,
    runId: opts.runId,
    profile: opts.profile,
    env: opts.env,
    log,
    platform,
    signal,
    params,
    param: (name, fallback) => params[name] ?? fallback,
    intParam: (name, fallback) => {
      const raw = params[name];
      if (raw === undefined) return fallback;
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new Error(`parameter ${name} must be an integer`);
      return n;
    },
    step: (name, fn) => rec.step(name, fn, log),
    assert(name, condition, details) {
      rec.record(name, condition, true, details);
      if (!condition) throw new AssertionFailure(name, details);
    },
    check(name, condition, details) {
      rec.record(name, condition, false, details);
      if (!condition) log.warn("check failed", { check: name });
      return condition;
    },
    metric: (name, value, unit) => rec.metric(name, value, unit),
    data: (key, value) => {
      rec.extra[key] = value;
    },
    defer: (fn) => {
      rec.cleanups.push(fn);
    },
  };
}

export async function runOne(
  scenario: Scenario,
  platform: Platform,
  opts: RunOptions & { runId: string },
): Promise<ScenarioResult> {
  const startedAt = new Date();
  const started = performance.now();
  const base = { name: scenario.name, description: scenario.description, startedAt: startedAt.toISOString() };
  const verdict = await evaluateNeeds(scenario.needs, opts.profile, (n) => platform.probe(n), opts.skipUnavailable);
  if (!verdict.run) {
    opts.log.warn(`scenario ${verdict.status}`, { scenario: scenario.name, reason: verdict.reason });
    return {
      ...base,
      status: verdict.status,
      durationMs: Math.round(performance.now() - started),
      steps: [],
      assertions: [],
      metrics: {},
      data: {},
      ...(verdict.status === "skipped" ? { skipReason: verdict.reason } : { error: verdict.reason }),
    };
  }

  const rec = new ScenarioRecorder();
  const timeoutMs = scenario.timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS;
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const ctx = makeContext(scenario, rec, platform, opts, controller.signal);
  let error: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  opts.log.info("scenario started", { scenario: scenario.name });
  try {
    await Promise.race([
      scenario.run(ctx),
      new Promise<never>(() => {
        timer = setTimeout(() => controller.abort(new Error(`scenario timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
      // Timeout and interruption both abort the signal; the reason says which.
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error("run aborted")),
          { once: true },
        );
      }),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
    if (!controller.signal.aborted) controller.abort(new Error("scenario finished"));
    await rec.runCleanups(ctx.log);
    await stopAll();
  }
  const status = error === undefined && !rec.failedSoftly ? "passed" : "failed";
  opts.log.info("scenario finished", { scenario: scenario.name, status, error });
  return {
    ...base,
    status,
    durationMs: Math.round(performance.now() - started),
    steps: rec.steps,
    assertions: rec.assertions,
    metrics: rec.metrics,
    data: rec.extra,
    ...(error === undefined ? {} : { error }),
  };
}

export async function runScenarios(scenarios: readonly Scenario[], opts: RunOptions): Promise<RunReport> {
  const runId = opts.runId ?? newRunId();
  const startedAt = new Date();
  const platform = opts.platform ?? new Platform(opts.env, opts.log, runId);
  const results: ScenarioResult[] = [];
  try {
    for (const scenario of scenarios) {
      if (opts.signal?.aborted) break;
      results.push(await runOne(scenario, platform, { ...opts, runId }));
    }
  } finally {
    if (!opts.platform) await platform.close();
  }
  const ffmpeg = await probeFfmpeg()
    .then((c) => c.version)
    .catch(() => null);
  const summary = summarizeResults(results);
  const finishedAt = new Date();
  return {
    runId,
    command: opts.command,
    profile: opts.profile,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    host: { platform: process.platform, arch: process.arch, bun: Bun.version, ffmpeg },
    targets: {
      api: opts.env.HARNESS_API_URL,
      web: opts.env.HARNESS_WEB_URL,
      origin: opts.env.HARNESS_ORIGIN_URL,
      rtmp: opts.env.HARNESS_RTMP_URL,
      whip: opts.env.HARNESS_WHIP_URL,
      player: opts.env.HARNESS_PLAYER,
    },
    scenarios: results,
    summary,
    ok: summary.failed === 0 && results.length > 0,
  };
}
