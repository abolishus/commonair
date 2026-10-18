// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Channel-level signals: chat-to-viewer ratio, follow bursts, raid integrity. */
import { clamp01, round } from "./signals/combine.ts";

export interface ChatViewerInput {
  /** Verified concurrent viewers now. */
  viewers: number;
  /** Distinct chatters over the same window. */
  chatters: number;
  /** The channel's own historical chatters/viewers ratio, or null when it has no history. */
  baselineRatio: number | null;
  /** chatters/viewers of other live channels right now (the platform distribution). */
  platformRatios: readonly number[];
}

export interface ChatViewerOptions {
  /** Below this many viewers the ratio is too noisy to judge. */
  minViewers: number;
  /** Anomalous when the ratio is below baseline × this factor. */
  baselineFactor: number;
  /** …and below this percentile of the platform distribution. */
  platformPercentile: number;
  /** Platform comparison needs at least this many channels. */
  minPlatformSamples: number;
}

export const CHAT_VIEWER_DEFAULTS: ChatViewerOptions = {
  minViewers: 50,
  baselineFactor: 0.2,
  platformPercentile: 0.05,
  minPlatformSamples: 20,
};

export interface ChatViewerResult {
  anomalous: boolean;
  score: number;
  ratio: number;
  /** The ratio the channel was compared against (baseline, else platform median). */
  reference: number | null;
  /** Viewers the chat activity would normally imply. */
  impliedViewers: number | null;
  checks: { baseline: boolean | null; platform: boolean | null };
}

/** Linear-interpolated percentile of a sample (p in [0, 1]). */
export function percentile(xs: readonly number[], p: number): number {
  const s = xs.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  const pos = clamp01(p) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/**
 * `chat_viewer_anomaly`: far more viewers than the chat activity supports, judged against
 * both the channel's own baseline and the platform distribution (when each is available;
 * at least one must be). A channel flagged here is reviewed, not auto-excluded: quiet
 * audiences exist.
 */
export function chatToViewerAnomaly(
  input: ChatViewerInput,
  opts: ChatViewerOptions = CHAT_VIEWER_DEFAULTS,
): ChatViewerResult {
  const viewers = Math.max(0, input.viewers);
  const ratio = viewers > 0 ? Math.max(0, input.chatters) / viewers : 0;
  const base = input.baselineRatio !== null && input.baselineRatio > 0 ? input.baselineRatio : null;
  const platformOk = input.platformRatios.length >= opts.minPlatformSamples;
  const checks = {
    baseline: base === null ? null : ratio < base * opts.baselineFactor,
    platform: platformOk ? ratio < percentile(input.platformRatios, opts.platformPercentile) : null,
  };
  const reference = base ?? (platformOk ? percentile(input.platformRatios, 0.5) : null);
  const known = [checks.baseline, checks.platform].filter((c) => c !== null);
  const anomalous = viewers >= opts.minViewers && known.length > 0 && known.every(Boolean);
  const score = anomalous && reference !== null && reference > 0 ? round(clamp01(1 - ratio / reference)) : 0;
  return {
    anomalous,
    score,
    ratio: round(ratio),
    reference: reference === null ? null : round(reference),
    impliedViewers: reference && reference > 0 ? Math.round(input.chatters / reference) : null,
    checks,
  };
}

export interface FollowFact {
  followerId: string;
  channelId: string;
  createdAt: Date;
  accountCreatedAt: Date;
  /** Seconds the follower had watched this channel before following. */
  priorViewingSeconds: number;
  /** Already excluded by an earlier run (still counted toward the burst). */
  alreadyExcluded?: boolean;
}

export interface FollowBurstOptions {
  perMinute: number;
  /** Accounts younger than this when they followed are "fresh". */
  minAccountAgeDays: number;
}

export interface FollowBurst {
  minuteStart: Date;
  follows: number;
  excluded: number;
}

/**
 * `follow_burst`: in any minute with more than `perMinute` follows on a channel, follows
 * from fresh accounts or from accounts that never watched the channel are excluded.
 * Established viewers following during a raid or a big moment are kept.
 */
export function followBurst(
  follows: readonly FollowFact[],
  opts: FollowBurstOptions,
): { bursts: FollowBurst[]; excluded: FollowFact[] } {
  const byMinute = new Map<number, FollowFact[]>();
  for (const f of follows) {
    const minute = Math.floor(f.createdAt.getTime() / 60_000) * 60_000;
    const list = byMinute.get(minute) ?? [];
    list.push(f);
    byMinute.set(minute, list);
  }
  const bursts: FollowBurst[] = [];
  const excluded: FollowFact[] = [];
  for (const [minute, list] of [...byMinute].sort((a, b) => a[0] - b[0])) {
    if (list.length <= opts.perMinute) continue;
    const suspicious = list.filter(
      (f) =>
        f.priorViewingSeconds <= 0 ||
        f.createdAt.getTime() - f.accountCreatedAt.getTime() < opts.minAccountAgeDays * 86_400_000,
    );
    bursts.push({ minuteStart: new Date(minute), follows: list.length, excluded: suspicious.length });
    excluded.push(...suspicious.filter((f) => !f.alreadyExcluded));
  }
  return { bursts, excluded };
}

export interface RaidCheck {
  ok: boolean;
  /** The viewer count the raid may carry: never more than the source's verified viewers. */
  allowedViewers: number;
  overstatement: number;
}

/** `raid_overstated`: a raid may carry at most the verified viewers of the source channel. */
export function raidIntegrity(raidViewerCount: number, verifiedSourceViewers: number): RaidCheck {
  const claimed = Math.max(0, Math.floor(raidViewerCount));
  const verified = Math.max(0, Math.floor(verifiedSourceViewers));
  return {
    ok: claimed <= verified,
    allowedViewers: Math.min(claimed, verified),
    overstatement: Math.max(0, claimed - verified),
  };
}
