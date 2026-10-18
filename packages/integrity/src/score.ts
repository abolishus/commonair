// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Session verdicts. Every signal is a small pure function returning a strength in
 * [0, 1] with an explanation; strengths combine as a noisy-OR into the session score.
 *
 *   score >  sessionExcludeScore            → excluded
 *   otherwise, fewer than 3 heartbeats      → pending
 *   otherwise                                → verified
 *
 * Reasons list every signal that fired (strongest first), so even a verified session
 * shows what was noticed about it.
 */
import type { NetworkClassifier } from "./network.ts";
import { noisyOr } from "./signals/combine.ts";
import { fetchSignal } from "./signals/fetch.ts";
import { headlessSignal } from "./signals/headless.ts";
import { heartbeatSignal } from "./signals/heartbeat.ts";
import { concurrencySignal, datacenterSignal } from "./signals/network.ts";
import {
  type FetchSummary,
  type HeartbeatSample,
  INSUFFICIENT_HEARTBEATS,
  type ScoringContext,
  type SessionFacts,
  type SessionScore,
  type Signal,
} from "./types.ts";

export const MIN_HEARTBEATS_TO_VERIFY = 3;

/** Merge the session-start fingerprint with the latest one reported in a heartbeat. */
function fingerprintOf(session: SessionFacts, beats: readonly HeartbeatSample[]): Record<string, unknown> {
  const latest = [...beats].reverse().find((b) => b.fingerprint)?.fingerprint ?? {};
  return { ...session.fingerprint, ...latest };
}

export function scoreSession(
  session: SessionFacts,
  heartbeats: readonly HeartbeatSample[],
  fetches: FetchSummary,
  context: ScoringContext,
  classifier?: NetworkClassifier,
): SessionScore {
  const signals = [
    datacenterSignal(session, classifier),
    concurrencySignal("device_concurrency", context.device, context.maxSessionsPerDevice),
    concurrencySignal("account_concurrency", context.account, context.maxSessionsPerDevice),
    headlessSignal(fingerprintOf(session, heartbeats), session.userAgent),
    heartbeatSignal(heartbeats),
    fetchSignal(session, fetches, context),
  ]
    .filter((s): s is Signal => s !== null && s.score > 0)
    .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));

  const score = noisyOr(signals.map((s) => s.score));
  const reasons: string[] = signals.map((s) => s.code);
  const beats = Math.max(session.heartbeats, heartbeats.length);
  if (score > context.sessionExcludeScore) return { verdict: "excluded", score, reasons, signals };
  if (beats < MIN_HEARTBEATS_TO_VERIFY) {
    return { verdict: "pending", score, reasons: [...reasons, INSUFFICIENT_HEARTBEATS], signals };
  }
  return { verdict: "verified", score, reasons, signals };
}
