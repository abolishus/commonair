// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The "Ready to go live" checklist's rules (overhaul wave 3, D5.1), pure so every edge is unit
 * tested: which steps show, which one is current, the phase (before and after the first stream),
 * the time estimates, the `?intent=` the dashboard accepts and the live check's backoff.
 */
import type { StreamSetupState } from "@commonair/contracts/dto";
import type { StreamSetupStep } from "@commonair/contracts/enums";

export type SetupStep = StreamSetupState["steps"][number];

/** `/dashboard?intent=stream|import` (growth-funnels: where the sign-up intent lands). */
export type DashboardIntent = "stream" | "import";

export interface DashboardSearch {
  intent?: DashboardIntent;
}

/** The route's `validateSearch`: anything but the two intents is dropped. */
export function parseDashboardSearch(search: Record<string, unknown>): DashboardSearch {
  const intent = search.intent;
  return intent === "stream" || intent === "import" ? { intent } : {};
}

/**
 * Minutes each step usually takes (creator-studio.md P1: runtime labels, no badges). Null: the
 * step has no estimate (going live is the encoder's button, not ours). No total is shown until the
 * funnel measures one (voice-copy 4.8).
 */
export const STEP_MINUTES: Readonly<Record<StreamSetupStep, number | null>> = {
  channel_profile: 1,
  stream_info: 1,
  stream_key: 2,
  encoder_connected: 3,
  rehearsal: 5,
  first_live: null,
  import_twitch: 2,
  get_paid: 3,
  bring_your_audience: 1,
};

/** Steps that apply to this channel (`done` null means it does not), in the API's order. */
export function visibleSteps(state: StreamSetupState): SetupStep[] {
  return state.steps.filter((s) => s.done !== null);
}

/** The steps before the first stream; "Bring your audience" waits for the recap side. */
const BEFORE_FIRST: ReadonlySet<StreamSetupStep> = new Set([
  "channel_profile",
  "stream_info",
  "stream_key",
  "encoder_connected",
  "rehearsal",
  "first_live",
  "import_twitch",
]);

/**
 * Optional steps the "After your first stream" card still lists while open: "Get paid" never
 * blocks `complete`, but setting up payouts belongs in the first-run path (ux-journeys J2-h).
 */
const LISTED_AFTER_FIRST: ReadonlySet<StreamSetupStep> = new Set(["get_paid"]);

/** Open and listed after the first stream: every required step, and the optional ones above. */
const openAfterFirst = (s: SetupStep) => s.done === false && (!s.optional || LISTED_AFTER_FIRST.has(s.step));

export type ChecklistPhase = "setup" | "after" | "complete";

/**
 * `setup` until the first live stream ("Ready to go live"), then `after` while a step is still
 * open ("After your first stream": a required one, or "Get paid"), then `complete` (nothing to show).
 */
export function checklistPhase(state: StreamSetupState): ChecklistPhase {
  const live = state.steps.find((s) => s.step === "first_live")?.done === true;
  if (!live) return "setup";
  // The API's `complete` covers the required steps; the listed optional ones keep the card open.
  const listedOpen = state.steps.some((s) => LISTED_AFTER_FIRST.has(s.step) && s.done === false);
  return state.complete && !listedOpen ? "complete" : "after";
}

/**
 * The steps a phase lists: before the first stream every applicable step up to going live, plus
 * "Bring your audience" for someone who signed up to import (they have viewers elsewhere already,
 * ux-journeys J2-a); after it, only the required steps still open, and "Get paid" while open.
 */
export function phaseSteps(state: StreamSetupState, phase: ChecklistPhase = checklistPhase(state)): SetupStep[] {
  const steps = visibleSteps(state);
  if (phase === "setup")
    return steps.filter(
      (s) => BEFORE_FIRST.has(s.step) || (s.step === "bring_your_audience" && state.signupIntent === "import"),
    );
  if (phase === "after") return steps.filter(openAfterFirst);
  return [];
}

/**
 * The step that expands: `?intent=import` opens the import while it is open; otherwise the first
 * required step not done yet, then the first optional one. Null when everything listed is done.
 */
export function currentStep(steps: readonly SetupStep[], intent?: DashboardIntent): StreamSetupStep | null {
  if (intent === "import") {
    const imp = steps.find((s) => s.step === "import_twitch" && s.done === false);
    if (imp) return imp.step;
  }
  const open = steps.filter((s) => s.done === false);
  return (open.find((s) => !s.optional) ?? open[0])?.step ?? null;
}

export function progressOf(steps: readonly SetupStep[]): { done: number; total: number } {
  return { done: steps.filter((s) => s.done === true).length, total: steps.length };
}

/** The live check's pace while the encoder step is current and the page is visible. */
export const SETUP_POLL_MS = 10_000;
/** After failures the pace backs off to at most this. */
export const SETUP_POLL_MAX_MS = 60_000;
/** "Still nothing after a minute?" (voice-copy 4.8). */
export const ENCODER_SLOW_MS = 60_000;

/** The wait before the next live check after `failures` failed ones in a row: 10, 20, 40, 60 s. */
export function setupPollDelay(failures: number): number {
  const n = Math.max(0, Math.floor(failures));
  return Math.min(SETUP_POLL_MAX_MS, SETUP_POLL_MS * 2 ** n);
}

/** `1920x1080` (the API's spelling) as `1920×1080`. */
export function resolutionLabel(resolution: string): string {
  return resolution.replace(/x/gi, "×");
}
