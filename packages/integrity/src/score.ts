// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Session verdicts. Every signal is a small pure function returning a strength in
 * [0, 1] with an explanation; strengths combine as a noisy-OR into the session score.
 *
 *   score >  sessionExcludeScore                 → excluded
 *   otherwise, fewer than 3 heartbeats           → pending (insufficient_heartbeats)
 *   otherwise, media not confirmed by delivery   → pending (media_unconfirmed)
 *   otherwise                                    → verified
 *
 * Reasons list every signal that fired (strongest first), so even a verified session
 * shows what was noticed about it. Signals covered by an allowance (an overturned appeal
 * or an admin `allowed` decision) are left out and the reason `allowed_on_appeal` is added.
 */
import type { NetworkClassifier } from "./network.ts";
import { noisyOr } from "./signals/combine.ts";
import { fetchChecks, fetchSignal } from "./signals/fetch.ts";
import { headlessSignal } from "./signals/headless.ts";
import { heartbeatSignal } from "./signals/heartbeat.ts";
import { concurrencySignal, datacenterSignal } from "./signals/network.ts";
import {
  ALLOWED_ON_APPEAL,
  type FetchEvidence,
  type HeartbeatSample,
  INSUFFICIENT_HEARTBEATS,
  MEDIA_UNCONFIRMED,
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
  fetches: FetchEvidence,
  context: ScoringContext,
  classifier?: NetworkClassifier,
): SessionScore {
  const allowance = context.allowance ?? null;
  const covered = new Set(allowance?.codes ?? []);
  // Only beats received after the decision are new evidence for the timing checks.
  const newBeats = allowance ? heartbeats.filter((b) => b.at > allowance.since) : heartbeats;
  const all = [
    datacenterSignal(session, classifier),
    concurrencySignal("device_concurrency", context.device, context.maxSessionsPerDevice),
    concurrencySignal("account_concurrency", context.account, context.maxSessionsPerDevice),
    headlessSignal(fingerprintOf(session, heartbeats), session.userAgent),
    heartbeatSignal(newBeats),
    fetchSignal(session, fetches, context),
  ]
    .filter((s): s is Signal => s !== null && s.score > 0)
    .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  const signals = all.filter((s) => !covered.has(s.code));
  const allowedSome = signals.length < all.length;

  const score = noisyOr(signals.map((s) => s.score));
  const reasons: string[] = signals.map((s) => s.code);
  if (allowedSome) reasons.push(ALLOWED_ON_APPEAL);
  const beats = Math.max(session.heartbeats, heartbeats.length);
  if (score > context.sessionExcludeScore) return { verdict: "excluded", score, reasons, signals };
  if (beats < MIN_HEARTBEATS_TO_VERIFY) {
    return { verdict: "pending", score, reasons: [...reasons, INSUFFICIENT_HEARTBEATS], signals };
  }
  const media = fetchChecks(session, fetches, context);
  if (media.mediaUnconfirmed && !covered.has("fetch_pattern")) {
    return { verdict: "pending", score, reasons: [...reasons, MEDIA_UNCONFIRMED], signals };
  }
  return { verdict: "verified", score, reasons, signals };
}
