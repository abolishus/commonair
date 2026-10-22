// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Scenario runner: checks each scenario's needs, runs it with a deadline and an abort signal,
 * records steps/assertions/metrics, always runs its cleanups, and stops any stray child process
 * before the next scenario. Under `--profile no-proprietary` it first checks that the stack
 * itself runs without vendor adapters, then skips (and reports) what needs them.
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
  type Profile,
  type Scenario,
  type ScenarioContext,
  ScenarioRecorder,
  type ScenarioResult,
  type StepSkip,
  excludedNeeds,
} from "./scenario.ts";
import { errorMessage } from "./redact.ts";

export const DEFAULT_SCENARIO_TIMEOUT_MS = 10 * 60_000;

export type NeedsVerdict = { run: true } | { run: false; status: "skipped" | "failed"; reason: string };

const profileReason = (needs: readonly Need[]) => `needs ${needs.join(", ")} (no-proprietary profile)`;

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
  const vendor = excludedNeeds(needs, profile);
  if (vendor.length > 0) return { run: false, status: "skipped", reason: profileReason(vendor) };
  const problems: string[] = [];
  for (const need of needs) {
    const problem = await probe(need);
    if (problem) problems.push(`${need}: ${problem}`);
  }
  if (problems.length === 0) return { run: true };
  return { run: false, status: skipUnavailable ? "skipped" : "failed", reason: `unmet needs — ${problems.join("; ")}` };
}

export interface ScenarioPlan {
  /** Needs to probe: the scenario's plus those of its active parameter variants. */
  needs: Need[];
  /** Set when the profile skips the whole scenario. */
  skip: string | null;
  /** Inactive variants the profile would skip anyway, reported as skipped steps. */
  skippedSteps: StepSkip[];
}

/** What a scenario needs for these parameters, and what the profile skips. Pure. */
export function planScenario(
  scenario: Pick<Scenario, "needs" | "paramNeeds">,
  profile: Profile,
  params: Readonly<Record<string, string>>,
): ScenarioPlan {
  const needs = new Set<Need>(scenario.needs);
  const skippedSteps: StepSkip[] = [];
  const vendor = excludedNeeds(scenario.needs, profile);
  let skip = vendor.length > 0 ? profileReason(vendor) : null;
  for (const pn of scenario.paramNeeds ?? []) {
    const excluded = excludedNeeds(pn.needs, profile);
    if (params[pn.param] === pn.value) {
      if (excluded.length > 0) skip ??= `${pn.step} (--set ${pn.param}=${pn.value}) ${profileReason(excluded)}`;
      for (const n of pn.needs) needs.add(n);
    } else if (excluded.length > 0) {
      skippedSteps.push({ name: `${pn.step} (--set ${pn.param}=${pn.value})`, reason: profileReason(excluded) });
    }
  }
  return { needs: [...needs], skip, skippedSteps };
}

/** The `/healthz` booleans that say whether the API runs a vendor adapter (E6 spec). */
export const PROPRIETARY_HEALTH_KEYS = ["stripe", "oauth", "cdn"] as const satisfies readonly Need[];

const HEALTH_HINTS: Record<(typeof PROPRIETARY_HEALTH_KEYS)[number], string> = {
  stripe: "PAYMENTS_PROVIDER=stripe",
  oauth: "an OAuth provider's client id and secret are set",
  cdn: "CDN_PROVIDER and CDN_BASE_URL are set",
};

/**
 * Why a stack fails the `no-proprietary` profile, from the API's `/healthz` body (empty when it
 * passes). Fails closed: a missing or non-boolean flag is a problem, not a pass. Pure.
 */
export function proprietaryProblems(health: unknown): string[] {
  if (typeof health !== "object" || health === null) return ["the API /healthz body is not a JSON object"];
  const h = health as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of PROPRIETARY_HEALTH_KEYS) {
    const v = h[key];
    if (v === true) problems.push(`${key}=true (${HEALTH_HINTS[key]})`);
    else if (v !== false) problems.push(`/healthz does not report ${key} as a boolean`);
  }
  return problems;
}

/** Check the stack for the profile; null when it may run, else the message the run fails with. */
export async function profilePreflight(
  profile: Profile,
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (profile !== "no-proprietary") return null;
  const url = `${apiUrl.replace(/\/+$/, "")}/healthz`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!res) return `--profile no-proprietary: the API /healthz is unreachable at ${new URL(url).origin}`;
  const body: unknown = await res.json().catch(() => null);
  const problems = proprietaryProblems(body);
  if (problems.length === 0) return null;
  return `--profile no-proprietary: the stack runs proprietary adapters or cannot say: ${problems.join("; ")}. Restart it without them (bun scripts/infra.ts stack --harness with them unset in .env).`;
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
  /** Fetch for the profile preflight (tests). */
  fetch?: typeof fetch;
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
  const step = <T>(name: string, fn: () => Promise<T> | T) => rec.step(name, fn, log);
  const skipStep = (name: string, reason: string) => {
    rec.skipped.push({ name, reason });
    log.warn("step skipped", { step: name, reason });
  };
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
    step,
    async optionalStep(name, needs, fn) {
      const excluded = excludedNeeds(needs, opts.profile);
      if (excluded.length > 0) {
        skipStep(name, profileReason(excluded));
        return undefined;
      }
      return step(name, fn);
    },
    skipStep,
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
  const plan = planScenario(scenario, opts.profile, opts.params ?? {});
  const verdict: NeedsVerdict = plan.skip
    ? { run: false, status: "skipped", reason: plan.skip }
    : await evaluateNeeds(plan.needs, opts.profile, (n) => platform.probe(n), opts.skipUnavailable);
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
  for (const s of plan.skippedSteps) rec.skipped.push(s);
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
    error = errorMessage(err);
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
    ...(rec.skipped.length > 0 ? { skippedSteps: [...rec.skipped] } : {}),
  };
}

/** The result that stands for a run the profile preflight refused. */
export function preflightFailure(profile: Profile, message: string): ScenarioResult {
  return {
    name: `${profile} preflight`,
    description: `the stack satisfies the ${profile} profile`,
    status: "failed",
    startedAt: new Date().toISOString(),
    durationMs: 0,
    steps: [],
    assertions: [{ name: "no proprietary adapter on the stack", passed: false, hard: true }],
    metrics: {},
    data: {},
    error: message,
  };
}

export async function runScenarios(scenarios: readonly Scenario[], opts: RunOptions): Promise<RunReport> {
  const runId = opts.runId ?? newRunId();
  const startedAt = new Date();
  const results: ScenarioResult[] = [];
  const refused = await profilePreflight(opts.profile, opts.env.HARNESS_API_URL, opts.fetch);
  if (refused) {
    opts.log.error("profile preflight failed", { profile: opts.profile, reason: refused });
    results.push(preflightFailure(opts.profile, refused));
  } else {
    const platform = opts.platform ?? new Platform(opts.env, opts.log, runId);
    try {
      for (const scenario of scenarios) {
        if (opts.signal?.aborted) break;
        results.push(await runOne(scenario, platform, { ...opts, runId }));
      }
    } finally {
      if (!opts.platform) await platform.close();
    }
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

export interface SkipRow {
  scenario: string;
  /** null = the whole scenario. */
  step: string | null;
  reason: string;
}

/** Every skip in a run: whole scenarios and single steps, in run order. Pure. */
export function skipRows(results: readonly ScenarioResult[]): SkipRow[] {
  const rows: SkipRow[] = [];
  for (const r of results) {
    if (r.status === "skipped") rows.push({ scenario: r.name, step: null, reason: r.skipReason ?? "skipped" });
    for (const s of r.skippedSteps ?? []) rows.push({ scenario: r.name, step: s.name, reason: s.reason });
  }
  return rows;
}

/** The skip table printed at the end of a run (empty string when nothing was skipped). Pure. */
export function formatSkipTable(results: readonly ScenarioResult[]): string {
  const rows = skipRows(results);
  if (rows.length === 0) return "";
  const cells = rows.map((r) => [r.scenario, r.step ?? "(whole scenario)", r.reason] as const);
  const w0 = Math.max("scenario".length, ...cells.map((c) => c[0].length));
  const w1 = Math.max("step".length, ...cells.map((c) => c[1].length));
  const line = (a: string, b: string, c: string) => `${a.padEnd(w0)}  ${b.padEnd(w1)}  ${c}`;
  return [`skipped (${rows.length}):`, line("scenario", "step", "reason"), ...cells.map((c) => line(...c))].join("\n");
}
