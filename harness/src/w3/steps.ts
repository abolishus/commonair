// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The batch 7 scenarios' step selection (docs/testing/b7-selectors.md, "Scenarios"): the
 * `watch-room`, `portability`, `twitch-import` and `federation` scenarios (the `w3` shard), and the
 * extension steps W3 and B7-followups add to `interact`, `e5-coop`, `e2e-relay`, `trust-safety`,
 * `integrity-basic` and `rehearsal`. Pure. Owned by the orchestrator: **only the orchestrator
 * removes a step from a pending list, when it merges the unit that implements it.** Units fill
 * their step modules (`W3_EXTENSION_UNITS`, and the scenario modules named on each table).
 */
import { allSteps, parseSteps } from "../e8/steps.ts";
import type { W2Extension } from "../w2/steps.ts";

export { allSteps, parseSteps, withPrerequisites } from "../e8/steps.ts";

// ------------------------------------------------------------ new scenarios

/** `watch-room` (W3-watch-rooms; feature-wins §4.13): `src/w3/watch-rooms/`. */
export const WATCH_ROOM_STEPS = {
  1: "four chromium members in sync",
  2: "webkit member in sync",
  3: "mixed age bands refused",
  4: "minor refused on a mature channel",
  5: "channel-banned user refused",
  6: "blocked pair refused",
  7: "report captures the transcript",
  8: "retention removes old rooms",
} as const;
export type WatchRoomStep = keyof typeof WATCH_ROOM_STEPS;
export const WATCH_ROOM_STEP_NUMBERS: readonly WatchRoomStep[] = [1, 2, 3, 4, 5, 6, 7, 8];

/** `portability` (W3-portability; ADR 0037): `src/w3/portability/`. */
export const PORTABILITY_STEPS = {
  1: "move link converts",
  2: "grant then move notice",
  3: "bundle round trip",
  4: "t0 emote refused",
  5: "suspended channel's bundle refused",
} as const;
export type PortabilityStep = keyof typeof PORTABILITY_STEPS;
export const PORTABILITY_STEP_NUMBERS: readonly PortabilityStep[] = [1, 2, 3, 4, 5];

/** `twitch-import` (N3-import; ADR 0031): `src/n3/`, against the mock in `src/mocks/twitch/`. */
export const TWITCH_IMPORT_STEPS = {
  1: "connect through the mock",
  2: "preview",
  3: "import",
  4: "channel page shows the title",
  5: "emotes in chat, t0 emote rejected",
  6: "schedule carried",
  7: "panels pasted",
  8: "token revoked",
  9: "unavailable when off",
} as const;
export type TwitchImportStep = keyof typeof TWITCH_IMPORT_STEPS;
export const TWITCH_IMPORT_STEP_NUMBERS: readonly TwitchImportStep[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** `federation` (N4-delivery, N4-web, N4-api; ADR 0030): `src/n4/`, against `src/mocks/activitypub/`. */
export const FEDERATION_STEPS = {
  1: "turn federation on",
  2: "webfinger and actor",
  3: "follow accepted",
  4: "go-live note delivered",
  5: "vod delivered",
  6: "undo stops delivery",
  7: "blocked domain refused",
  8: "suspension deletes the actor",
} as const;
export type FederationStep = keyof typeof FEDERATION_STEPS;
export const FEDERATION_STEP_NUMBERS: readonly FederationStep[] = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * Steps whose implementing unit has not merged yet: selectable explicitly (`--set steps=1`) but
 * left out of `all`, so the full harness on main stays green while they are stubs.
 */
export const PENDING_WATCH_ROOM_STEPS: readonly WatchRoomStep[] = [1, 2, 3, 4, 5, 6, 7, 8];
export const PENDING_PORTABILITY_STEPS: readonly PortabilityStep[] = [1, 2, 3, 4, 5];
export const PENDING_TWITCH_IMPORT_STEPS: readonly TwitchImportStep[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
export const PENDING_FEDERATION_STEPS: readonly FederationStep[] = [1, 2, 3, 4, 5, 6, 7, 8];

/** The WebKit member joins the room step 1 opened; every refusal sets up its own room. */
export const WATCH_ROOM_STEP_PREREQUISITES: Readonly<Record<WatchRoomStep, readonly WatchRoomStep[]>> = {
  1: [],
  2: [1],
  3: [],
  4: [],
  5: [],
  6: [],
  7: [],
  8: [],
};
/** The move notifies the follower step 1's link converted; the T0 emote rides step 3's bundle. */
export const PORTABILITY_STEP_PREREQUISITES: Readonly<Record<PortabilityStep, readonly PortabilityStep[]>> = {
  1: [],
  2: [1],
  3: [],
  4: [3],
  5: [],
};
/**
 * Preview needs the connection, the import the preview, and the checks the import; the
 * revocation follows the preview's read. Panels are pasted without Twitch, and the unavailable
 * state is its own check.
 */
export const TWITCH_IMPORT_STEP_PREREQUISITES: Readonly<Record<TwitchImportStep, readonly TwitchImportStep[]>> = {
  1: [],
  2: [1],
  3: [2],
  4: [3],
  5: [3],
  6: [2],
  7: [],
  8: [2],
  9: [],
};
/** Everything after the switch reads the peer's follow; the VOD is the go-live's broadcast. */
export const FEDERATION_STEP_PREREQUISITES: Readonly<Record<FederationStep, readonly FederationStep[]>> = {
  1: [],
  2: [1],
  3: [2],
  4: [3],
  5: [4],
  6: [3],
  7: [1],
  8: [3],
};

export const parseWatchRoomSteps = (value: string): WatchRoomStep[] =>
  parseSteps(value, WATCH_ROOM_STEP_NUMBERS, PENDING_WATCH_ROOM_STEPS);
export const parsePortabilitySteps = (value: string): PortabilityStep[] =>
  parseSteps(value, PORTABILITY_STEP_NUMBERS, PENDING_PORTABILITY_STEPS);
export const parseTwitchImportSteps = (value: string): TwitchImportStep[] =>
  parseSteps(value, TWITCH_IMPORT_STEP_NUMBERS, PENDING_TWITCH_IMPORT_STEPS);
export const parseFederationSteps = (value: string): FederationStep[] =>
  parseSteps(value, FEDERATION_STEP_NUMBERS, PENDING_FEDERATION_STEPS);
export const allWatchRoomSteps = (): WatchRoomStep[] => allSteps(WATCH_ROOM_STEP_NUMBERS, PENDING_WATCH_ROOM_STEPS);
export const allPortabilitySteps = (): PortabilityStep[] =>
  allSteps(PORTABILITY_STEP_NUMBERS, PENDING_PORTABILITY_STEPS);
export const allTwitchImportSteps = (): TwitchImportStep[] =>
  allSteps(TWITCH_IMPORT_STEP_NUMBERS, PENDING_TWITCH_IMPORT_STEPS);
export const allFederationSteps = (): FederationStep[] => allSteps(FEDERATION_STEP_NUMBERS, PENDING_FEDERATION_STEPS);

/** Step titles for the report: `3. mixed age bands refused: <what>`. */
export function watchRoomTitle(n: WatchRoomStep, what: string): string {
  return `${n}. ${WATCH_ROOM_STEPS[n]}: ${what}`;
}
export function portabilityTitle(n: PortabilityStep, what: string): string {
  return `${n}. ${PORTABILITY_STEPS[n]}: ${what}`;
}
export function twitchImportTitle(n: TwitchImportStep, what: string): string {
  return `${n}. ${TWITCH_IMPORT_STEPS[n]}: ${what}`;
}
export function federationTitle(n: FederationStep, what: string): string {
  return `${n}. ${FEDERATION_STEPS[n]}: ${what}`;
}

// ------------------------------------------------------------ extensions

/**
 * The extension steps each existing scenario runs, in order (the unit that writes each is in
 * `W3_EXTENSION_UNITS`). `interact` runs its extensions after its own steps; `e5-coop` after its last step;
 * `e2e-relay` while the Go relay is active and its viewers verified (before the liar and the
 * drain); `trust-safety` around its steps (before step 1 and after the last), as W2's
 * `enforcement`; `integrity-basic` after W2's extensions; `rehearsal` after its steps.
 */
export const W3_EXTENSIONS = {
  interact: ["giveaway", "surge-raid", "fair-prediction"],
  "e5-coop": ["jury"],
  "e2e-relay": ["dvr-relay", "dvr-purge", "relay-vtt"],
  "trust-safety": ["sor-resolve"],
  "integrity-basic": ["group-appeal-threshold"],
  rehearsal: ["moderation-samples"],
} as const;
export type W3ExtendedScenario = keyof typeof W3_EXTENSIONS;
export type W3Extension<S extends W3ExtendedScenario = W3ExtendedScenario> = (typeof W3_EXTENSIONS)[S][number];

/**
 * Which unit implements each extension, and the module it lives in (relative to `src/w3/`).
 * B7-followups' steps live in the W2 modules it owns.
 */
export const W3_EXTENSION_UNITS: Readonly<Record<W3Extension, { unit: string; file: string }>> = {
  giveaway: { unit: "W3-giveaways", file: "giveaways.ts" },
  "surge-raid": { unit: "W3-surge-raids", file: "surge-raids.ts" },
  "fair-prediction": { unit: "W3-fair-predictions", file: "predictions.ts" },
  jury: { unit: "W3-jury", file: "jury.ts" },
  "dvr-relay": { unit: "W3-dvr-relay", file: "dvr-relay/index.ts" },
  "dvr-purge": { unit: "W3-dvr-relay", file: "dvr-relay/index.ts" },
  "relay-vtt": { unit: "W3-dvr-relay", file: "dvr-relay/index.ts" },
  "sor-resolve": { unit: "B7-followups", file: "../w2/enforcement.ts" },
  "group-appeal-threshold": { unit: "B7-followups", file: "../w2/group-appeals.ts" },
  "moderation-samples": { unit: "B7-followups", file: "../w2/rehearsal/index.ts" },
};

/**
 * Steps whose implementing unit has not merged yet: selectable explicitly (`--set w3=giveaway`)
 * but left out of `all`.
 */
export const PENDING_W3_EXTENSIONS: readonly W3Extension[] = [
  "giveaway",
  "surge-raid",
  "fair-prediction",
  "jury",
  "dvr-relay",
  "dvr-purge",
  "relay-vtt",
  "sor-resolve",
  "group-appeal-threshold",
  "moderation-samples",
];

/** The purge check evicts a DVR segment the relay cached for `dvr-relay`'s rewinding viewer. */
export const W3_EXTENSION_PREREQUISITES: Readonly<Record<W3Extension, readonly W3Extension[]>> = {
  giveaway: [],
  "surge-raid": [],
  "fair-prediction": [],
  jury: [],
  "dvr-relay": [],
  "dvr-purge": ["dvr-relay"],
  "relay-vtt": [],
  "sor-resolve": [],
  "group-appeal-threshold": [],
  "moderation-samples": [],
};

/**
 * The scenario's own steps an extension needs: `moderation-samples` reads the report of the
 * rehearsal step 1 arms and publishes. `e2e-relay` and `integrity-basic` have no step selection.
 */
export const W3_SCENARIO_STEP_PREREQUISITES: Readonly<Record<W3Extension, readonly number[]>> = {
  giveaway: [],
  "surge-raid": [],
  "fair-prediction": [],
  jury: [],
  "dvr-relay": [],
  "dvr-purge": [],
  "relay-vtt": [],
  "sor-resolve": [],
  "group-appeal-threshold": [],
  "moderation-samples": [1],
};

/**
 * The W2 extensions of the same scenario a W3 extension needs: the threshold check overturns a
 * group of the rollup W2's `group` wrote and `signed` signed, as `group-appeal` does.
 */
export const W3_W2_PREREQUISITES: Readonly<Record<W3Extension, readonly W2Extension[]>> = {
  giveaway: [],
  "surge-raid": [],
  "fair-prediction": [],
  jury: [],
  "dvr-relay": [],
  "dvr-purge": [],
  "relay-vtt": [],
  "sor-resolve": [],
  "group-appeal-threshold": ["group", "signed"],
  "moderation-samples": [],
};

export interface W3Selection<S extends W3ExtendedScenario> {
  /** The extensions to run, in the scenario's order. */
  run: W3Extension<S>[];
  /** Prerequisites added to what was named. */
  added: W3Extension<S>[];
}

/**
 * `--set w3=` for one extended scenario → the extension steps to run, in the scenario's order,
 * with the extensions they need. Empty or `all`: every extension of that scenario that is not
 * pending. Otherwise a comma-separated list of that scenario's extensions (pending ones included)
 * or `none`. Throws on a name the scenario does not have, so a typo never silently runs fewer
 * checks.
 */
export function w3Extensions<S extends W3ExtendedScenario>(scenario: S, value: string): W3Selection<S> {
  const own: readonly W3Extension<S>[] = W3_EXTENSIONS[scenario];
  const v = value.trim().toLowerCase();
  if (v === "none") return { run: [], added: [] };
  const wanted = new Set<W3Extension<S>>();
  if (v === "" || v === "all") {
    for (const e of own) if (!(PENDING_W3_EXTENSIONS as readonly string[]).includes(e)) wanted.add(e);
  } else {
    for (const raw of v.split(",")) {
      const name = raw.trim();
      if (name === "") continue;
      if (!(own as readonly string[]).includes(name))
        throw new Error(`w3: "${name}" is not an extension of ${scenario} (${own.join(", ")})`);
      wanted.add(name as W3Extension<S>);
    }
    if (wanted.size === 0) throw new Error("w3: no extension selected");
  }
  const named = new Set(wanted);
  // Prerequisites are always of the same scenario; close over them transitively.
  const stack = [...wanted];
  while (stack.length > 0) {
    const e = stack.pop() as W3Extension<S>;
    for (const p of W3_EXTENSION_PREREQUISITES[e] as readonly W3Extension<S>[])
      if (!wanted.has(p)) {
        wanted.add(p);
        stack.push(p);
      }
  }
  return { run: own.filter((e) => wanted.has(e)), added: own.filter((e) => wanted.has(e) && !named.has(e)) };
}

/** The scenario steps the selected extensions need (sorted, unique), to add to `--set steps=`. */
export function w3StepsNeeded(extensions: readonly W3Extension[]): number[] {
  return [...new Set(extensions.flatMap((e) => W3_SCENARIO_STEP_PREREQUISITES[e]))].sort((a, b) => a - b);
}

/**
 * The scenario's selected steps plus the ones the extensions need, and which were added. The
 * scenario then applies its own step prerequisites to the result.
 */
export function withW3Steps<N extends number>(
  steps: readonly N[],
  extensions: readonly W3Extension[],
): { steps: N[]; added: N[] } {
  const have = new Set<number>(steps);
  const added = w3StepsNeeded(extensions).filter((n) => !have.has(n)) as N[];
  return { steps: [...steps, ...added].sort((a, b) => a - b), added };
}

/**
 * The W2 extensions the selected W3 extensions need that the W2 selection lacks (in no order).
 * A scenario adds them to its `--set w2=` value and selects again, so W2's own prerequisites follow.
 */
export function w3W2Missing(extensions: readonly W3Extension[], w2Run: readonly W2Extension[]): W2Extension[] {
  const have = new Set<W2Extension>(w2Run);
  return [...new Set(extensions.flatMap((e) => W3_W2_PREREQUISITES[e]))].filter((e) => !have.has(e));
}

/** Step title for the report: `w3 giveaway: <what>`. */
export function w3ExtensionTitle(name: W3Extension, what: string): string {
  return `w3 ${name}: ${what}`;
}
