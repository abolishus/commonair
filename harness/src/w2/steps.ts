// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The W2 scenarios' step selection (docs/testing/w2-selectors.md, "Scenarios"; batch 6): the
 * `captions`, `live-dvr` and `rehearsal` scenarios, and the extension steps W2 adds to
 * `e4b-money`, `integrity-basic`, `trust-safety` and `timeline-sync`. Pure. Owned by the
 * orchestrator: **only the orchestrator removes a step from a pending list, when it merges the
 * unit that implements it.** Units fill their step modules in `src/w2/`.
 */
import { allSteps, parseSteps } from "../e8/steps.ts";

export { allSteps, parseSteps, withPrerequisites } from "../e8/steps.ts";

// ------------------------------------------------------------ new scenarios

/** `captions` (W2-captions; ADR 0011). */
export const CAPTIONS_STEPS = {
  1: "subtitles advertised",
  2: "word error rate",
  3: "cue timing",
  4: "vod captions",
  5: "queued at the cap",
  6: "no transcript without vods",
  7: "no track for a rehearsal",
  8: "mask words",
} as const;
export type CaptionsStep = keyof typeof CAPTIONS_STEPS;
export const CAPTIONS_STEP_NUMBERS: readonly CaptionsStep[] = [1, 2, 3, 4, 5, 6, 7, 8];

/** `live-dvr` (W2-dvr; ADR 0016). */
export const DVR_STEPS = {
  1: "dvr viewers verify but are not live",
  2: "in-progress segment refused",
  3: "removal closes the window",
  4: "relay refuses dvr",
  5: "subscribers vod refuses a stranger",
  6: "data-mode token refused",
  7: "vods off means no dvr",
} as const;
export type DvrStep = keyof typeof DVR_STEPS;
export const DVR_STEP_NUMBERS: readonly DvrStep[] = [1, 2, 3, 4, 5, 6, 7];

/** `rehearsal` (W2-rehearsal; feature-wins §4.11, batch 6 decisions (f), (g)). */
export const REHEARSAL_STEPS = {
  1: "arm and publish",
  2: "invisible downstream",
  3: "nothing counts",
  4: "simulated chat report",
  5: "invitee playback",
  6: "rehearsal vod",
  7: "audit",
} as const;
export type RehearsalStep = keyof typeof REHEARSAL_STEPS;
export const REHEARSAL_STEP_NUMBERS: readonly RehearsalStep[] = [1, 2, 3, 4, 5, 6, 7];

/**
 * Steps whose implementing unit has not merged yet: selectable explicitly (`--set steps=1`) but
 * left out of `all`, so the full harness on main stays green while they are stubs.
 */
export const PENDING_CAPTIONS_STEPS: readonly CaptionsStep[] = [1, 2, 3, 4, 5, 6, 7, 8];
export const PENDING_DVR_STEPS: readonly DvrStep[] = [1, 2, 3, 4, 5, 6, 7];
export const PENDING_REHEARSAL_STEPS: readonly RehearsalStep[] = [1, 2, 3, 4, 5, 6, 7];

/** Captions and DVR steps each set up their own channel and viewers. */
export const CAPTIONS_STEP_PREREQUISITES: Readonly<Record<CaptionsStep, readonly CaptionsStep[]>> = {
  1: [],
  2: [],
  3: [],
  4: [],
  5: [],
  6: [],
  7: [],
  8: [],
};
export const DVR_STEP_PREREQUISITES: Readonly<Record<DvrStep, readonly DvrStep[]>> = {
  1: [],
  2: [],
  3: [],
  4: [],
  5: [],
  6: [],
  7: [],
};
/** Every rehearsal check reads the rehearsal step 1 arms and publishes. */
export const REHEARSAL_STEP_PREREQUISITES: Readonly<Record<RehearsalStep, readonly RehearsalStep[]>> = {
  1: [],
  2: [1],
  3: [1],
  4: [1],
  5: [1],
  6: [1],
  7: [1],
};

export const parseCaptionsSteps = (value: string): CaptionsStep[] =>
  parseSteps(value, CAPTIONS_STEP_NUMBERS, PENDING_CAPTIONS_STEPS);
export const parseDvrSteps = (value: string): DvrStep[] => parseSteps(value, DVR_STEP_NUMBERS, PENDING_DVR_STEPS);
export const parseRehearsalSteps = (value: string): RehearsalStep[] =>
  parseSteps(value, REHEARSAL_STEP_NUMBERS, PENDING_REHEARSAL_STEPS);
export const allCaptionsSteps = (): CaptionsStep[] => allSteps(CAPTIONS_STEP_NUMBERS, PENDING_CAPTIONS_STEPS);
export const allDvrSteps = (): DvrStep[] => allSteps(DVR_STEP_NUMBERS, PENDING_DVR_STEPS);
export const allRehearsalSteps = (): RehearsalStep[] => allSteps(REHEARSAL_STEP_NUMBERS, PENDING_REHEARSAL_STEPS);

/** Step titles for the report: `3. cue timing: <what>`. */
export function captionsTitle(n: CaptionsStep, what: string): string {
  return `${n}. ${CAPTIONS_STEPS[n]}: ${what}`;
}
export function dvrTitle(n: DvrStep, what: string): string {
  return `${n}. ${DVR_STEPS[n]}: ${what}`;
}
export function rehearsalTitle(n: RehearsalStep, what: string): string {
  return `${n}. ${REHEARSAL_STEPS[n]}: ${what}`;
}

// ------------------------------------------------------------ extensions

/**
 * The extension steps each existing scenario runs, in order (the unit that writes each is in
 * `W2_EXTENSION_UNITS`). `e4b-money` and `integrity-basic` run theirs at the end (integrity-basic
 * after its viewers stop); `trust-safety` runs `enforcement` around its steps (before step 1 and
 * after the last); `timeline-sync` runs `replay-panel` after its steps.
 */
export const W2_EXTENSIONS = {
  "e4b-money": ["split-release", "split-clawback", "split-won-chargeback", "split-new-payee"],
  "integrity-basic": ["group", "signed", "tamper", "group-appeal"],
  "trust-safety": ["enforcement"],
  "timeline-sync": ["replay-panel"],
} as const;
export type W2ExtendedScenario = keyof typeof W2_EXTENSIONS;
export type W2Extension<S extends W2ExtendedScenario = W2ExtendedScenario> = (typeof W2_EXTENSIONS)[S][number];

/** Which unit implements each extension, and the module it lives in (`src/w2/<file>.ts`). */
export const W2_EXTENSION_UNITS: Readonly<Record<W2Extension, { unit: string; file: string }>> = {
  "split-release": { unit: "W2-splits", file: "splits.ts" },
  "split-clawback": { unit: "W2-splits", file: "splits.ts" },
  "split-won-chargeback": { unit: "W2-splits", file: "splits.ts" },
  "split-new-payee": { unit: "W2-splits", file: "splits.ts" },
  group: { unit: "W2-rollup-analytics", file: "rollup.ts" },
  signed: { unit: "W2b-attestations", file: "attestations.ts" },
  tamper: { unit: "W2b-attestations", file: "attestations.ts" },
  "group-appeal": { unit: "W2b-group-appeals", file: "group-appeals.ts" },
  enforcement: { unit: "W2-enforcement-report", file: "enforcement.ts" },
  "replay-panel": { unit: "W2-vod-watch", file: "replay.ts" },
};

/**
 * Steps whose implementing unit has not merged yet: selectable explicitly (`--set w2=group`) but
 * left out of `all`. Every one is pending until its unit merges.
 */
export const PENDING_W2_EXTENSIONS: readonly W2Extension[] = [
  "split-release",
  "split-clawback",
  "split-won-chargeback",
  "split-new-payee",
  "group",
  "signed",
  "tamper",
  "group-appeal",
  "enforcement",
  "replay-panel",
];

/**
 * Extensions that read what another left: an attestation is signed over the rollup's figures, the
 * tamper check modifies the signed entry, and a group appeal's overturn re-scores the rollup's
 * group and appends a `supersede` entry to the signed chain.
 */
export const W2_EXTENSION_PREREQUISITES: Readonly<Record<W2Extension, readonly W2Extension[]>> = {
  "split-release": [],
  "split-clawback": [],
  "split-won-chargeback": [],
  "split-new-payee": [],
  group: [],
  signed: ["group"],
  tamper: ["signed"],
  "group-appeal": ["group", "signed"],
  enforcement: [],
  "replay-panel": [],
};

/**
 * The scenario's own steps an extension needs: `enforcement` reads the report around the T2 label
 * and T1 restriction (trust-safety steps 4 and 5, with step 4's overturned appeal); `replay-panel`
 * plays the VOD that live media time and replay exclusions leave (timeline-sync steps 1 and 3).
 */
export const W2_SCENARIO_STEP_PREREQUISITES: Readonly<Record<W2Extension, readonly number[]>> = {
  "split-release": [],
  "split-clawback": [],
  "split-won-chargeback": [],
  "split-new-payee": [],
  group: [],
  signed: [],
  tamper: [],
  "group-appeal": [],
  enforcement: [4, 5],
  "replay-panel": [1, 3],
};

export interface W2Selection<S extends W2ExtendedScenario> {
  /** The extensions to run, in the scenario's order. */
  run: W2Extension<S>[];
  /** Prerequisites added to what was named. */
  added: W2Extension<S>[];
}

/**
 * `--set w2=` for one extended scenario → the extension steps to run, in the scenario's order,
 * with the extensions they need. Empty or `all`: every extension of that scenario that is not
 * pending. Otherwise a comma-separated list of that scenario's extensions (pending ones included)
 * or `none`. Throws on a name the scenario does not have, so a typo never silently runs fewer
 * checks.
 */
export function w2Extensions<S extends W2ExtendedScenario>(scenario: S, value: string): W2Selection<S> {
  const own: readonly W2Extension<S>[] = W2_EXTENSIONS[scenario];
  const v = value.trim().toLowerCase();
  if (v === "none") return { run: [], added: [] };
  const wanted = new Set<W2Extension<S>>();
  if (v === "" || v === "all") {
    for (const e of own) if (!(PENDING_W2_EXTENSIONS as readonly string[]).includes(e)) wanted.add(e);
  } else {
    for (const raw of v.split(",")) {
      const name = raw.trim();
      if (name === "") continue;
      if (!(own as readonly string[]).includes(name))
        throw new Error(`w2: "${name}" is not an extension of ${scenario} (${own.join(", ")})`);
      wanted.add(name as W2Extension<S>);
    }
    if (wanted.size === 0) throw new Error("w2: no extension selected");
  }
  const named = new Set(wanted);
  // Prerequisites are always of the same scenario; close over them transitively.
  const stack = [...wanted];
  while (stack.length > 0) {
    const e = stack.pop() as W2Extension<S>;
    for (const p of W2_EXTENSION_PREREQUISITES[e] as readonly W2Extension<S>[])
      if (!wanted.has(p)) {
        wanted.add(p);
        stack.push(p);
      }
  }
  return { run: own.filter((e) => wanted.has(e)), added: own.filter((e) => wanted.has(e) && !named.has(e)) };
}

/** The scenario steps the selected extensions need (sorted, unique), to add to `--set steps=`. */
export function w2StepsNeeded(extensions: readonly W2Extension[]): number[] {
  return [...new Set(extensions.flatMap((e) => W2_SCENARIO_STEP_PREREQUISITES[e]))].sort((a, b) => a - b);
}

/**
 * The scenario's selected steps plus the ones the extensions need, and which were added. The
 * scenario then applies its own step prerequisites to the result.
 */
export function withW2Steps<N extends number>(
  steps: readonly N[],
  extensions: readonly W2Extension[],
): { steps: N[]; added: N[] } {
  const have = new Set<number>(steps);
  const added = w2StepsNeeded(extensions).filter((n) => !have.has(n)) as N[];
  return { steps: [...steps, ...added].sort((a, b) => a - b), added };
}

/** Step title for the report: `w2 group: <what>`. */
export function w2ExtensionTitle(name: W2Extension, what: string): string {
  return `w2 ${name}: ${what}`;
}
