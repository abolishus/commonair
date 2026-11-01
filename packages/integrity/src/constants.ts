// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integrity constants shared by the scorer, the per-broadcast rollup, attestations and group
 * appeals (ADR 0014 decisions 2 and 3, batch 6 decisions (k), (m)). One place, so the worker's
 * rollup and the API's analytics read the same settle delay and the same category of a signal.
 */
import type { ExclusionCategory } from "@commonair/contracts/enums";
import { SESSION_SIGNALS, type SessionSignalCode } from "./types.ts";

/**
 * The scorer revisits an ended session for this long after it ends (`scoreActiveSessions`
 * `finalizeSeconds`); past it a verdict no longer moves on its own.
 */
export const DEFAULT_FINALIZE_SECONDS = 3600;

/**
 * ADR 0014 decision 3: the rollup and the attestation job run this long after `stream.offline`.
 * At least the finalize window plus the slowest integrity job's interval and run limit
 * (3600 + 300 + 1200 s today); `services/worker/tests/integrity-settle.test.ts` checks it.
 */
export const AUDIENCE_SETTLE_SECONDS = 7200;

/**
 * Bumped with any change to what a signal or a verdict means; signed into every attestation's
 * `thresholdsHash` and logged in `docs/governance/integrity-ruleset-changelog.md`.
 */
export const RULESET_VERSION = 1;

/**
 * The exclusion category of every session signal (decision (k)): what analytics, attestations and
 * group appeals show instead of a signal code. Exhaustive, so a new signal cannot ship without one.
 */
export const SIGNAL_CATEGORIES: Readonly<Record<SessionSignalCode, ExclusionCategory>> = {
  datacenter_ip: "datacenter",
  privacy_relay: "privacy_relay",
  device_concurrency: "concurrency",
  account_concurrency: "concurrency",
  headless: "automation",
  heartbeat_inconsistent: "playback_pattern",
  fetch_pattern: "playback_pattern",
};

const SIGNALS: ReadonlySet<string> = new Set(SESSION_SIGNALS);

/** The category of one reason code, or null for a non-signal reason (`insufficient_heartbeats`, …). */
export function categoryOfReason(reason: string): ExclusionCategory | null {
  return SIGNALS.has(reason) ? SIGNAL_CATEGORIES[reason as SessionSignalCode] : null;
}

/**
 * An excluded session's category: that of its first signal reason (reasons are sorted by score,
 * strongest first, `score.ts`). An excluded session with no known signal (an admin decision, a
 * code retired since) is `other`.
 */
export function exclusionCategoryOf(reasons: readonly string[]): ExclusionCategory {
  for (const r of reasons) {
    const c = categoryOfReason(r);
    if (c) return c;
  }
  return "other";
}
