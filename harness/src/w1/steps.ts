// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The W1 scenarios' step selection (docs/testing/w1-selectors.md, "Scenarios"): `timeline-sync`
 * (media time, replay order, exclusions, retention), `surge-guard` (the verified-watch gate and the
 * surge guard), and the extension steps W1 adds to `e4b-money`, `e2e-social` and
 * `integrity-basic`. Pure. Owned by the orchestrator: **only the orchestrator removes a step from
 * a pending list, when it merges the unit that implements it.**
 */
import { allSteps, parseSteps } from "../e8/steps.ts";

export { allSteps, parseSteps, withPrerequisites } from "../e8/steps.ts";

export const TIMELINE_STEPS = {
  1: "live media time",
  2: "browser viewers at forced latencies",
  3: "replay exclusions",
  4: "retention",
} as const;
export type TimelineStep = keyof typeof TIMELINE_STEPS;
export const TIMELINE_STEP_NUMBERS: readonly TimelineStep[] = [1, 2, 3, 4];

export const SURGE_STEPS = {
  1: "bots refused",
  2: "CDN-assigned bot refused",
  3: "per-address cap",
  4: "real viewers chat after 60 s",
  5: "audio-only screen-reader viewer",
  6: "surge trips and reverts",
  7: "studio and mod banner",
} as const;
export type SurgeStep = keyof typeof SURGE_STEPS;
export const SURGE_STEP_NUMBERS: readonly SurgeStep[] = [1, 2, 3, 4, 5, 6, 7];

/** The extension steps each existing scenario runs at its end, in order. */
export const W1_EXTENSIONS = {
  "e4b-money": ["breakdown", "reconciliation", "fraud-hold"],
  "e2e-social": ["flood", "block"],
  "integrity-basic": ["data-mode"],
} as const;
export type W1ExtendedScenario = keyof typeof W1_EXTENSIONS;
export type W1Extension<S extends W1ExtendedScenario = W1ExtendedScenario> = (typeof W1_EXTENSIONS)[S][number];

/**
 * Steps whose implementing unit has not merged yet: selectable explicitly (`--set steps=1`,
 * `--set w1=breakdown`) but left out of `all`, so the full harness on main stays green while they
 * are stubs.
 */
export const PENDING_TIMELINE_STEPS: readonly TimelineStep[] = [];
export const PENDING_SURGE_STEPS: readonly SurgeStep[] = [];
export const PENDING_W1_EXTENSIONS: readonly W1Extension[] = [];

/** No W1 step needs another: each sets up its own channel, viewers and messages. */
export const TIMELINE_STEP_PREREQUISITES: Readonly<Record<TimelineStep, readonly TimelineStep[]>> = {
  1: [],
  2: [],
  3: [],
  4: [],
};
export const SURGE_STEP_PREREQUISITES: Readonly<Record<SurgeStep, readonly SurgeStep[]>> = {
  1: [],
  2: [],
  3: [],
  4: [],
  5: [],
  6: [],
  7: [],
};

export const parseTimelineSteps = (value: string): TimelineStep[] =>
  parseSteps(value, TIMELINE_STEP_NUMBERS, PENDING_TIMELINE_STEPS);
export const parseSurgeSteps = (value: string): SurgeStep[] =>
  parseSteps(value, SURGE_STEP_NUMBERS, PENDING_SURGE_STEPS);
export const allTimelineSteps = (): TimelineStep[] => allSteps(TIMELINE_STEP_NUMBERS, PENDING_TIMELINE_STEPS);
export const allSurgeSteps = (): SurgeStep[] => allSteps(SURGE_STEP_NUMBERS, PENDING_SURGE_STEPS);

/**
 * `--set w1=` for one extended scenario → the extension steps to run, in the scenario's order.
 * Empty or `all`: every extension of that scenario that is not pending. Otherwise a
 * comma-separated list of that scenario's extensions (pending ones included) or `none`. Throws on
 * a name the scenario does not have, so a typo never silently runs fewer checks.
 */
export function w1Extensions<S extends W1ExtendedScenario>(scenario: S, value: string): W1Extension<S>[] {
  const own: readonly W1Extension<S>[] = W1_EXTENSIONS[scenario];
  const v = value.trim().toLowerCase();
  if (v === "" || v === "all") return own.filter((e) => !(PENDING_W1_EXTENSIONS as readonly string[]).includes(e));
  if (v === "none") return [];
  const wanted = new Set<string>();
  for (const raw of v.split(",")) {
    const name = raw.trim();
    if (name === "") continue;
    if (!(own as readonly string[]).includes(name))
      throw new Error(`w1: "${name}" is not an extension of ${scenario} (${own.join(", ")})`);
    wanted.add(name);
  }
  if (wanted.size === 0) throw new Error("w1: no extension selected");
  return own.filter((e) => wanted.has(e));
}

/** Step titles for the report: `3. replay exclusions: <what>`, `w1 breakdown: <what>`. */
export function timelineTitle(n: TimelineStep, what: string): string {
  return `${n}. ${TIMELINE_STEPS[n]}: ${what}`;
}
export function surgeTitle(n: SurgeStep, what: string): string {
  return `${n}. ${SURGE_STEPS[n]}: ${what}`;
}
export function extensionTitle(name: W1Extension, what: string): string {
  return `w1 ${name}: ${what}`;
}
