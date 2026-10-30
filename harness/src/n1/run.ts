// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `notifications` scenario's run state and step contract (docs/testing/n1-selectors.md, ADR
 * 0028): the actors, what one step leaves for the next (`N1State`), the step shape every unit's
 * module exports, and the selection rule. Owned by the orchestrator: units send a contract request
 * instead of editing it, and **only the orchestrator removes a step from `PENDING_N1_STEPS`, when it
 * merges the unit that implements it.**
 */
import type { Logger } from "@commonair/observability";
import type { BrowserFleet } from "../browser-viewer.ts";
import type { HarnessEnv } from "../env.ts";
import type { Via } from "../money.ts";
import type { Platform } from "../platform.ts";
import type { Need, ScenarioContext } from "../scenario.ts";
import type { SignedInUser } from "../users.ts";
import { parseSteps } from "../e8/steps.ts";
import type { E8Streamer } from "../e8/kit.ts";
import type { PushReceiver } from "./push-receiver.ts";

/**
 * A push subscription the harness made itself, as a browser would (`harness/src/n1/ece.ts`): the
 * endpoint is the harness receiver, `keys` are what the API stores (base64url, RFC 8291), and the
 * private half stays here to decrypt what arrives. Never logged or reported.
 */
export interface HarnessPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  privateKey: CryptoKey;
}

/** What steps leave for later steps. Every field is set by the step that owns it. */
export interface N1State {
  /** Step 1: the first streamer's channel slug (step 3 restarts it). */
  firstChannel?: string;
  /** Step 2: the second streamer's channel slug. */
  emailChannel?: string;
  /** Step 4: the third streamer's channel slug (in its cooldown afterwards). */
  pushChannel?: string;
  /** Step 7: the fourth streamer's channel slug. */
  webPushChannel?: string;
  /** Step 4: the subscription registered over the API. */
  apiSubscription?: HarnessPushSubscription;
}

export interface N1Run {
  ctx: ScenarioContext;
  platform: Platform;
  log: Logger;
  env: HarnessEnv;
  via: Via;
  actors: {
    /** Follows every streamer (bell on); receives the notifications. */
    viewer: SignedInUser;
    /**
     * One fresh channel per go-live, because the cooldown blocks a second go-live of a channel for
     * four hours: steps 1 and 3 use the first, 2 the second, 4 the third, 7 the fourth.
     */
    streamers: [E8Streamer, E8Streamer, E8Streamer, E8Streamer];
  };
  receiver: PushReceiver;
  state: N1State;
  /** Set when `via=web` and a selected web step will run. */
  browser?: BrowserFleet;
}

export const N1_STEP_NUMBERS = [1, 2, 3, 4, 5, 6, 7] as const;
export type N1StepNumber = (typeof N1_STEP_NUMBERS)[number];

/**
 * Steps whose implementing unit has not merged yet: reported pending and skipped under `all`, but
 * run when named (`--set steps=4`), so a unit can try its step on a live stack.
 */
export const PENDING_N1_STEPS: readonly N1StepNumber[] = [];

/** What every step module exports as `step` (the owning unit implements `run`). */
export interface N1Step {
  name: string;
  /** The unit that owns the module, e.g. `N1-fanout`. */
  owner: string;
  /** Steps whose state this one reads; it runs only when they run too. */
  needs: number[];
  /** Only meaningful in a browser: skipped with `via=api`. */
  webOnly?: true;
  /** Optional vendor-shaped needs (`webPush`): run through `ctx.optionalStep`, skipped under `no-proprietary`. */
  requires?: Need[];
  run(run: N1Run): Promise<void>;
}

/** A not-merged step module's `run`. */
export function notMerged(owner: string): () => Promise<void> {
  return () => Promise.reject(new Error(`${owner} not merged`));
}

export interface N1Selection {
  steps: N1StepNumber[];
  /** False for `all` (or empty): pending steps are then reported and skipped. */
  explicit: boolean;
}

/** `--set steps=` (numbers, ranges `1-3`, `all`/empty for all seven). Throws on a typo. */
export function parseN1Steps(value: string): N1Selection {
  const v = value.trim().toLowerCase();
  return { steps: parseSteps(value, N1_STEP_NUMBERS, []), explicit: v !== "" && v !== "all" };
}

export interface N1Plan {
  run: N1StepNumber[];
  skipped: { step: N1StepNumber; reason: string }[];
}

/**
 * In order: a step runs when it is not pending (or was named explicitly), not `webOnly` under
 * `via=api`, and every step it needs runs too (so a need that is pending, skipped or not selected
 * skips it, transitively). Everything else is reported with its reason, so `full` stays green
 * while units are in flight. Pure.
 */
export function planN1Steps(
  selection: N1Selection,
  steps: Readonly<Record<N1StepNumber, Pick<N1Step, "owner" | "needs" | "webOnly">>>,
  via: Via,
  pending: readonly N1StepNumber[] = PENDING_N1_STEPS,
): N1Plan {
  const runs = new Set<number>();
  const plan: N1Plan = { run: [], skipped: [] };
  for (const n of [...selection.steps].sort((a, b) => a - b)) {
    const s = steps[n];
    if (!selection.explicit && pending.includes(n))
      plan.skipped.push({ step: n, reason: `pending: ${s.owner} not merged` });
    else if (s.webOnly && via === "api") plan.skipped.push({ step: n, reason: "web only (via=api)" });
    else {
      const missing = s.needs.filter((m) => !runs.has(m));
      if (missing.length > 0)
        plan.skipped.push({ step: n, reason: `needs step${missing.length > 1 ? "s" : ""} ${missing.join(", ")}` });
      else {
        runs.add(n);
        plan.run.push(n);
      }
    }
  }
  return plan;
}
