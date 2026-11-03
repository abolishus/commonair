// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The batch 8 extension steps (docs/testing/b8-selectors.md, "Scenarios"; batch 8 contract step
 * §4.3): the steps M1-gifts-refunds, M1-connect, M1-coop-money, B8-server, B8-web and B8-player add
 * to existing scenarios, selected with `--set b8=`. Pure. Owned by the orchestrator: **only the
 * orchestrator removes an extension from `PENDING_B8_EXTENSIONS`, when it merges the unit that
 * implements it.** Units fill their step modules (`B8_EXTENSION_UNITS`) and never edit this file.
 */

// ------------------------------------------------------------ extensions

/**
 * The extension steps each scenario runs, in order (the unit that writes each is in
 * `B8_EXTENSION_UNITS`). Every one runs after the scenario's own steps and after its W1, W2 and W3
 * extensions, except in `trust-safety`, where each runs around the steps (`before` ahead of the
 * first step, `after` once the last has run), as W2's `enforcement`.
 */
export const B8_EXTENSIONS = {
  "e4b-money": [
    "gift-window",
    "auto-refund",
    "refund-unknown",
    "connect-transfer",
    "transfer-reversed",
    "receipt-email",
  ],
  "e5-coop": ["share-stripe", "patronage-payout"],
  interact: ["grace-bet-web", "giveaway-verify-mine", "raid-restart-keeps-raid"],
  "watch-room": ["edge-sync"],
  "twitch-import": ["field-choices", "channel-panels-banner", "import-expiry"],
  federation: ["actor-disabled-event"],
  portability: ["incoming-cleanup"],
  "data-export": ["giveaway-section"],
  "trust-safety": ["sor-staff-action", "lapsed-ban-signin"],
  "relay-dvr": ["relay-dvr-switch"],
} as const;
export type B8ExtendedScenario = keyof typeof B8_EXTENSIONS;
export type B8Extension<S extends B8ExtendedScenario = B8ExtendedScenario> = (typeof B8_EXTENSIONS)[S][number];

/**
 * Scenarios not wired yet: `relay-dvr` is the scenario B8-harness splits out of `e2e-relay` in
 * wave 2. The orchestrator wires `relay-dvr-switch` into it when B8-harness merges, and removes
 * the scenario from this list.
 */
export const UNWIRED_B8_SCENARIOS: readonly B8ExtendedScenario[] = ["relay-dvr"];

/** Which unit implements each extension, and the module it lives in (relative to `src/b8/`). */
export const B8_EXTENSION_UNITS: Readonly<Record<B8Extension, { unit: string; file: string }>> = {
  "gift-window": { unit: "M1-gifts-refunds", file: "money-refunds.ts" },
  "auto-refund": { unit: "M1-gifts-refunds", file: "money-refunds.ts" },
  "refund-unknown": { unit: "M1-gifts-refunds", file: "money-refunds.ts" },
  "receipt-email": { unit: "M1-gifts-refunds", file: "money-refunds.ts" },
  "connect-transfer": { unit: "M1-connect", file: "money-connect.ts" },
  "transfer-reversed": { unit: "M1-connect", file: "money-connect.ts" },
  "share-stripe": { unit: "M1-coop-money", file: "coop-money.ts" },
  "patronage-payout": { unit: "M1-coop-money", file: "coop-money.ts" },
  "grace-bet-web": { unit: "B8-web", file: "web.ts" },
  "giveaway-verify-mine": { unit: "B8-web", file: "web.ts" },
  "channel-panels-banner": { unit: "B8-web", file: "web.ts" },
  "raid-restart-keeps-raid": { unit: "B8-server", file: "server.ts" },
  "field-choices": { unit: "B8-server", file: "server.ts" },
  "import-expiry": { unit: "B8-server", file: "server.ts" },
  "actor-disabled-event": { unit: "B8-server", file: "server.ts" },
  "incoming-cleanup": { unit: "B8-server", file: "server.ts" },
  "giveaway-section": { unit: "B8-server", file: "server.ts" },
  "sor-staff-action": { unit: "B8-server", file: "server.ts" },
  "lapsed-ban-signin": { unit: "B8-server", file: "server.ts" },
  "edge-sync": { unit: "B8-player", file: "player.ts" },
  "relay-dvr-switch": { unit: "B8-player", file: "player.ts" },
};

/**
 * Extensions whose implementing unit has not merged yet: selectable explicitly
 * (`--set b8=gift-window`) but left out of `all`, so the full harness on main stays green while
 * they are stubs. Wave 1's were lifted at its merge; wave 2's remain.
 */
export const PENDING_B8_EXTENSIONS: readonly B8Extension[] = [
  "share-stripe",
  "patronage-payout",
  "edge-sync",
  "relay-dvr-switch",
];

/** The reversal reverses the transfer `connect-transfer` made. */
export const B8_EXTENSION_PREREQUISITES: Readonly<Record<B8Extension, readonly B8Extension[]>> = {
  "gift-window": [],
  "auto-refund": [],
  "refund-unknown": [],
  "connect-transfer": [],
  "transfer-reversed": ["connect-transfer"],
  "receipt-email": [],
  "share-stripe": [],
  "patronage-payout": [],
  "grace-bet-web": [],
  "giveaway-verify-mine": [],
  "raid-restart-keeps-raid": [],
  "edge-sync": [],
  "field-choices": [],
  "channel-panels-banner": [],
  "import-expiry": [],
  "actor-disabled-event": [],
  "incoming-cleanup": [],
  "giveaway-section": [],
  "sor-staff-action": [],
  "lapsed-ban-signin": [],
  "relay-dvr-switch": [],
};

/**
 * The scenario's own steps an extension needs: `import-expiry` ages the import step 3 finished;
 * `channel-panels-banner` reads the channel page after step 3's import and step 7's panels;
 * `actor-disabled-event` suspends a channel the peer follows (step 3). `e4b-money`, `e5-coop`,
 * `data-export` and `relay-dvr` have no step an extension may add.
 */
export const B8_SCENARIO_STEP_PREREQUISITES: Readonly<Record<B8Extension, readonly number[]>> = {
  "gift-window": [],
  "auto-refund": [],
  "refund-unknown": [],
  "connect-transfer": [],
  "transfer-reversed": [],
  "receipt-email": [],
  "share-stripe": [],
  "patronage-payout": [],
  "grace-bet-web": [],
  "giveaway-verify-mine": [],
  "raid-restart-keeps-raid": [],
  "edge-sync": [],
  "field-choices": [],
  "channel-panels-banner": [3, 7],
  "import-expiry": [3],
  "actor-disabled-event": [3],
  "incoming-cleanup": [],
  "giveaway-section": [],
  "sor-staff-action": [],
  "lapsed-ban-signin": [],
  "relay-dvr-switch": [],
};

export interface B8Selection<S extends B8ExtendedScenario> {
  /** The extensions to run, in the scenario's order. */
  run: B8Extension<S>[];
  /** Prerequisites added to what was named. */
  added: B8Extension<S>[];
}

/**
 * `--set b8=` for one extended scenario → the extension steps to run, in the scenario's order,
 * with the extensions they need. Empty or `all`: every extension of that scenario that is not
 * pending. Otherwise a comma-separated list of that scenario's extensions (pending ones included)
 * or `none`. Throws on a name the scenario does not have, so a typo never silently runs fewer
 * checks.
 */
export function b8Extensions<S extends B8ExtendedScenario>(scenario: S, value: string): B8Selection<S> {
  const own: readonly B8Extension<S>[] = B8_EXTENSIONS[scenario];
  const v = value.trim().toLowerCase();
  if (v === "none") return { run: [], added: [] };
  const wanted = new Set<B8Extension<S>>();
  if (v === "" || v === "all") {
    for (const e of own) if (!(PENDING_B8_EXTENSIONS as readonly string[]).includes(e)) wanted.add(e);
  } else {
    for (const raw of v.split(",")) {
      const name = raw.trim();
      if (name === "") continue;
      if (!(own as readonly string[]).includes(name))
        throw new Error(`b8: "${name}" is not an extension of ${scenario} (${own.join(", ")})`);
      wanted.add(name as B8Extension<S>);
    }
    if (wanted.size === 0) throw new Error("b8: no extension selected");
  }
  const named = new Set(wanted);
  // Prerequisites are always of the same scenario; close over them transitively.
  const stack = [...wanted];
  while (stack.length > 0) {
    const e = stack.pop() as B8Extension<S>;
    for (const p of B8_EXTENSION_PREREQUISITES[e] as readonly B8Extension<S>[])
      if (!wanted.has(p)) {
        wanted.add(p);
        stack.push(p);
      }
  }
  return { run: own.filter((e) => wanted.has(e)), added: own.filter((e) => wanted.has(e) && !named.has(e)) };
}

/** The scenario steps the selected extensions need (sorted, unique), to add to `--set steps=`. */
export function b8StepsNeeded(extensions: readonly B8Extension[]): number[] {
  return [...new Set(extensions.flatMap((e) => B8_SCENARIO_STEP_PREREQUISITES[e]))].sort((a, b) => a - b);
}

/**
 * The scenario's selected steps plus the ones the extensions need, and which were added. The
 * scenario then applies its own step prerequisites to the result.
 */
export function withB8Steps<N extends number>(
  steps: readonly N[],
  extensions: readonly B8Extension[],
): { steps: N[]; added: N[] } {
  const have = new Set<number>(steps);
  const added = b8StepsNeeded(extensions).filter((n) => !have.has(n)) as N[];
  return { steps: [...steps, ...added].sort((a, b) => a - b), added };
}

/** Step title for the report: `b8 gift-window: <what>`. */
export function b8ExtensionTitle(name: B8Extension, what: string): string {
  return `b8 ${name}: ${what}`;
}
