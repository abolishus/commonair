// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Scenario contract. A scenario is a module in `harness/scenarios/<name>.ts` whose default export
 * is `defineScenario({ name, description, needs, run })`. `run(ctx)` drives the stack like real
 * users and records steps, assertions and metrics on the context; the runner turns them into the
 * JSON + human report.
 */
import type { Logger } from "@commonair/observability";
import type { HarnessEnv } from "./env.ts";
import type { Platform } from "./platform.ts";
import { errorMessage } from "./redact.ts";

/** Parts of the stack (or the harness host) a scenario depends on. The runner probes each once. */
export const NEEDS = [
  "api",
  "web",
  "chat",
  "irc",
  "origin",
  "media",
  "relay",
  "worker",
  "mail",
  "stripe",
  "oauth",
  "cdn",
  "webPush",
  "ffmpeg",
  "whip",
  "browser",
  "prometheus",
  "podman",
] as const;
export type Need = (typeof NEEDS)[number];

/** Optional vendor adapters. Under `--profile no-proprietary` scenarios that need them are skipped. */
export const PROPRIETARY_NEEDS: readonly Need[] = ["stripe", "oauth", "cdn", "webPush"];

export const PROFILES = ["default", "no-proprietary"] as const;
export type Profile = (typeof PROFILES)[number];

/** The vendor needs among `needs` that the profile excludes (none under `default`). */
export function excludedNeeds(needs: readonly Need[], profile: Profile): Need[] {
  return profile === "no-proprietary" ? needs.filter((n) => PROPRIETARY_NEEDS.includes(n)) : [];
}

/**
 * A variant of a scenario selected by a `--set` parameter that needs more of the stack than the
 * default path (e.g. `e4b-money --set provider=stripe` needs stripe-mock). Active when
 * `params[param] === value`: its needs are probed with the scenario's. Under `no-proprietary`
 * an active vendor variant skips the scenario, and an inactive one is reported as a skipped step.
 */
export interface ParamNeed {
  param: string;
  value: string;
  needs: readonly Need[];
  /** Step name in the report, e.g. "Stripe variant". */
  step: string;
}

export interface Scenario {
  /** Must equal the module's file name. */
  name: string;
  description: string;
  needs: readonly Need[];
  /** Included when `full` is expanded (default true). */
  inFull?: boolean;
  /** Hard deadline for the whole scenario (default 10 minutes). */
  timeoutMs?: number;
  /** Parameter-selected variants with extra needs (see `ParamNeed`). */
  paramNeeds?: readonly ParamNeed[];
  run(ctx: ScenarioContext): Promise<void>;
}

export function defineScenario<T extends Scenario>(scenario: T): T {
  return scenario;
}

export interface StepResult {
  name: string;
  status: "passed" | "failed";
  durationMs: number;
  error?: string;
}

/** A step the profile left out, with the reason (reported, never run). */
export interface StepSkip {
  name: string;
  reason: string;
}

export interface AssertionResult {
  name: string;
  passed: boolean;
  /** Hard assertions stop the scenario; soft checks only mark it failed. */
  hard: boolean;
  details?: unknown;
}

export interface MetricValue {
  value: number;
  unit?: string;
}

export type ScenarioStatus = "passed" | "failed" | "skipped";

export interface ScenarioResult {
  name: string;
  description: string;
  status: ScenarioStatus;
  startedAt: string;
  durationMs: number;
  steps: StepResult[];
  assertions: AssertionResult[];
  metrics: Record<string, MetricValue>;
  /** Free-form structured data (e.g. the load-test breakdown). */
  data: Record<string, unknown>;
  error?: string;
  skipReason?: string;
  /** Steps the profile skipped (e.g. a vendor variant under `no-proprietary`). */
  skippedSteps?: StepSkip[];
}

export class AssertionFailure extends Error {
  constructor(
    readonly assertion: string,
    readonly details?: unknown,
  ) {
    super(`assertion failed: ${assertion}${details === undefined ? "" : ` (${safeJson(details)})`}`);
    this.name = "AssertionFailure";
  }
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 300 ? `${s.slice(0, 300)}…` : s;
  } catch {
    return String(v);
  }
}

export interface ScenarioContext {
  readonly name: string;
  readonly runId: string;
  readonly profile: Profile;
  readonly env: HarnessEnv;
  readonly log: Logger;
  readonly platform: Platform;
  /** Aborted when the scenario times out or the run is interrupted. */
  readonly signal: AbortSignal;
  /** `--set key=value` parameters. */
  readonly params: Readonly<Record<string, string>>;
  param(name: string, fallback: string): string;
  intParam(name: string, fallback: number): number;
  /** Run and time a named step; failures are recorded and rethrown. */
  step<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  /**
   * A step that needs parts of the stack the profile may exclude (stripe, oauth, cdn under
   * `no-proprietary`): skipped with the reason in the report (resolves to undefined), or run
   * like `step`.
   */
  optionalStep<T>(name: string, needs: readonly Need[], fn: () => Promise<T> | T): Promise<T | undefined>;
  /** Record a step as skipped, with its reason. */
  skipStep(name: string, reason: string): void;
  /** Hard assertion: records the outcome and throws on failure. */
  assert(name: string, condition: boolean, details?: unknown): void;
  /** Soft check: records the outcome; a failure marks the scenario failed but it continues. */
  check(name: string, condition: boolean, details?: unknown): boolean;
  metric(name: string, value: number | null | undefined, unit?: string): void;
  data(key: string, value: unknown): void;
  /** Register cleanup; runs in reverse order after the scenario, pass or fail. */
  defer(fn: () => unknown): void;
}

/** Recorder behind ScenarioContext; the runner owns one per scenario. */
export class ScenarioRecorder {
  readonly steps: StepResult[] = [];
  readonly assertions: AssertionResult[] = [];
  readonly metrics: Record<string, MetricValue> = {};
  readonly extra: Record<string, unknown> = {};
  readonly skipped: StepSkip[] = [];
  readonly cleanups: (() => unknown)[] = [];

  get failedSoftly(): boolean {
    return this.assertions.some((a) => !a.passed);
  }

  async step<T>(name: string, fn: () => Promise<T> | T, log?: Logger): Promise<T> {
    const started = performance.now();
    log?.info("step", { step: name });
    try {
      const value = await fn();
      this.steps.push({ name, status: "passed", durationMs: Math.round(performance.now() - started) });
      return value;
    } catch (err) {
      this.steps.push({
        name,
        status: "failed",
        durationMs: Math.round(performance.now() - started),
        error: errorMessage(err),
      });
      throw err;
    }
  }

  record(name: string, passed: boolean, hard: boolean, details?: unknown): void {
    this.assertions.push(details === undefined ? { name, passed, hard } : { name, passed, hard, details });
  }

  metric(name: string, value: number | null | undefined, unit?: string): void {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    this.metrics[name] = unit ? { value, unit } : { value };
  }

  async runCleanups(log?: Logger): Promise<void> {
    while (this.cleanups.length > 0) {
      const fn = this.cleanups.pop();
      try {
        await fn?.();
      } catch (err) {
        log?.warn("cleanup failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
