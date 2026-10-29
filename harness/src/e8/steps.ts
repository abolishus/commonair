// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The E8 scenarios' step selection (docs/testing/e8-selectors.md, "Scenarios"): `interact` (polls,
 * predictions, raids, goals, the studio and viewer pages) and `channel-bot` (commands, costs,
 * timers, viewbots, song requests, the studio page). Pure. Owned by the orchestrator: **only the
 * orchestrator removes a step from a pending list, when it merges the unit that implements it.**
 */

export const INTERACT_STEPS = {
  1: "poll",
  2: "prediction",
  3: "raid",
  4: "goal overlay",
  5: "studio",
  6: "viewer",
} as const;
export type InteractStep = keyof typeof INTERACT_STEPS;
export const INTERACT_STEP_NUMBERS: readonly InteractStep[] = [1, 2, 3, 4, 5, 6];

export const BOT_STEPS = {
  1: "commands",
  2: "points cost",
  3: "timer",
  4: "viewbots earn nothing",
  5: "song requests",
  6: "studio",
} as const;
export type BotStep = keyof typeof BOT_STEPS;
export const BOT_STEP_NUMBERS: readonly BotStep[] = [1, 2, 3, 4, 5, 6];

/**
 * Steps whose implementing unit has not merged yet: selectable explicitly (`--set steps=1`) but
 * left out of `all`, so the full harness on main stays green while they are stubs.
 */
export const PENDING_INTERACT_STEPS: readonly InteractStep[] = [];
export const PENDING_BOT_STEPS: readonly BotStep[] = [];

/** No E8 step needs another: each sets up its own channels, viewers and points. */
export const INTERACT_STEP_PREREQUISITES: Readonly<Record<InteractStep, readonly InteractStep[]>> = {
  1: [],
  2: [],
  3: [],
  4: [],
  5: [],
  6: [],
};
export const BOT_STEP_PREREQUISITES: Readonly<Record<BotStep, readonly BotStep[]>> = {
  1: [],
  2: [],
  3: [],
  4: [],
  5: [],
  6: [],
};

/** What `all` (and an empty selection) runs: every step not pending. */
export function allSteps<S extends number>(numbers: readonly S[], pending: readonly S[]): S[] {
  return numbers.filter((n) => !pending.includes(n));
}

/**
 * `--set steps=1,2,5` (also ranges `1-3`, or `all`/empty for every step not pending) → sorted
 * unique steps. Throws on anything else so a typo never silently runs fewer checks.
 */
export function parseSteps<S extends number>(value: string, numbers: readonly S[], pending: readonly S[]): S[] {
  const isStep = (n: number): n is S => (numbers as readonly number[]).includes(n);
  const span = `${numbers[0]}-${numbers.at(-1)}`;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "all") return allSteps(numbers, pending);
  const out = new Set<S>();
  for (const raw of v.split(",")) {
    const part = raw.trim();
    if (part === "") continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (!isStep(from) || !isStep(to) || from > to) throw new Error(`steps: bad range "${part}" (${span})`);
      for (let n = from; n <= to; n++) if (isStep(n)) out.add(n);
      continue;
    }
    if (!/^\d+$/.test(part)) throw new Error(`steps: "${part}" is not a step number (${span})`);
    const n = Number(part);
    if (!isStep(n)) throw new Error(`steps: ${n} is not a step (${span})`);
    out.add(n);
  }
  if (out.size === 0) throw new Error("steps: no step selected");
  return [...out].sort((a, b) => a - b);
}

export const parseInteractSteps = (value: string): InteractStep[] =>
  parseSteps(value, INTERACT_STEP_NUMBERS, PENDING_INTERACT_STEPS);
export const parseBotSteps = (value: string): BotStep[] => parseSteps(value, BOT_STEP_NUMBERS, PENDING_BOT_STEPS);

/** The selected steps plus the ones they need, and which were added. */
export function withPrerequisites<S extends number>(
  steps: readonly S[],
  prerequisites: Readonly<Record<S, readonly S[]>>,
): { steps: S[]; added: S[] } {
  const all = new Set<S>(steps);
  const added: S[] = [];
  for (const s of steps)
    for (const p of prerequisites[s])
      if (!all.has(p)) {
        all.add(p);
        added.push(p);
      }
  return { steps: [...all].sort((a, b) => a - b), added: added.sort((a, b) => a - b) };
}

/** Step title for the report: `3. raid: <what>`. */
export function interactTitle(n: InteractStep, what: string): string {
  return `${n}. ${INTERACT_STEPS[n]}: ${what}`;
}
export function botTitle(n: BotStep, what: string): string {
  return `${n}. ${BOT_STEPS[n]}: ${what}`;
}
