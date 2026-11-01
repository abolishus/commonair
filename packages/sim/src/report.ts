// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Assembling a rehearsal's checklist: chat outcomes tallied by the rule that caught them, and the
 * ingest checks with their timed dips ("bitrate below 50% of target at 12:04"). Pure; times are
 * epoch milliseconds the caller supplies.
 */
import type { SimMessageKind } from "./chat.ts";

export const CHAT_RULES = ["wordFilter", "link", "duplicate", "rateLimit", "other"] as const;
export type ChatRule = (typeof CHAT_RULES)[number];
export type RuleCounts = Record<ChatRule, number>;
export type ChatOutcome = "accepted" | "held" | "rejected";

export interface ChatTally {
  accepted: number;
  held: RuleCounts;
  rejected: RuleCounts;
}

const zeroCounts = (): RuleCounts => ({ wordFilter: 0, link: 0, duplicate: 0, rateLimit: 0, other: 0 });
export const emptyTally = (): ChatTally => ({ accepted: 0, held: zeroCounts(), rejected: zeroCounts() });

/** Chat notice codes (`NOTICE_CODES`) → the rule the report names. */
const RULE_BY_CODE: Readonly<Record<string, ChatRule>> = {
  msg_ratelimit: "rateLimit",
  msg_slowmode: "rateLimit",
  msg_duplicate: "duplicate",
  msg_links_blocked: "link",
};

/**
 * Which rule caught a message. A held message carries no code (only word filters hold), and a
 * filter rejection's `msg_rejected` is shared with middlewares, so the message's own kind decides
 * between the word filter and "other".
 */
export function ruleOf(outcome: Exclude<ChatOutcome, "accepted">, code: string | null, kind: SimMessageKind): ChatRule {
  const byCode = code ? RULE_BY_CODE[code] : undefined;
  if (byCode) return byCode;
  if (outcome === "held") return "wordFilter";
  if (code === "msg_rejected" && kind === "filtered") return "wordFilter";
  return "other";
}

/** Count one outcome (returns a new tally). */
export function tally(t: ChatTally, outcome: ChatOutcome, code: string | null, kind: SimMessageKind): ChatTally {
  if (outcome === "accepted") return { ...t, accepted: t.accepted + 1 };
  const rule = ruleOf(outcome, code, kind);
  return outcome === "held"
    ? { ...t, held: { ...t.held, [rule]: t.held[rule] + 1 } }
    : { ...t, rejected: { ...t.rejected, [rule]: t.rejected[rule] + 1 } };
}

export const sumCounts = (c: RuleCounts) => CHAT_RULES.reduce((n, r) => n + c[r], 0);

// ------------------------------------------------------------------ ingest

/** One stored health sample (`broadcast_health_samples`), as the media service writes it. */
export interface HealthSample {
  atMs: number;
  bitrateKbps: number;
  fps: number | null;
  keyframeIntervalMs: number | null;
  droppedFrames: number | null;
  warnings: readonly string[];
}

export const INGEST_CHECKS = ["bitrate", "fps", "keyframe_interval", "dropped_frames", "audio", "video"] as const;
export type IngestCheckName = (typeof INGEST_CHECKS)[number];

export interface Dip {
  /** When the dip started. */
  atMs: number;
  seconds: number;
}
export interface IngestCheck {
  check: IngestCheckName;
  ok: boolean;
  dips: Dip[];
}

/** A dip in bitrate is a sample below this share of the target (the session's median). */
export const BITRATE_DIP_FRACTION = 0.5;
/** A dip in frame rate is a measured rate below this share of the session's median. */
export const FPS_DIP_FRACTION = 0.9;
/** The media service samples every 5 s; the last dip of a run lasts at least one interval. */
export const DEFAULT_SAMPLE_INTERVAL_MS = 5000;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

const AUDIO_WARNINGS = new Set(["audio_missing", "audio_codec_unsupported"]);
const VIDEO_WARNINGS = new Set(["video_missing", "video_codec_unsupported"]);

/** Whether each sample fails one check (null = the sample cannot tell, e.g. no probe yet). */
function failures(
  samples: readonly HealthSample[],
  check: IngestCheckName,
  targetKbps: number | null,
): (boolean | null)[] {
  const fpsMedian = median(samples.flatMap((s) => (s.fps === null ? [] : [s.fps])));
  return samples.map((s) => {
    switch (check) {
      case "bitrate":
        return targetKbps === null ? null : s.bitrateKbps < targetKbps * BITRATE_DIP_FRACTION;
      case "fps":
        return s.fps === null || fpsMedian === null ? null : s.fps < fpsMedian * FPS_DIP_FRACTION;
      case "keyframe_interval":
        return s.warnings.includes("keyframe_interval");
      case "dropped_frames":
        return s.droppedFrames === null ? null : s.droppedFrames > 0;
      case "audio":
        return s.warnings.some((w) => AUDIO_WARNINGS.has(w));
      case "video":
        return s.warnings.some((w) => VIDEO_WARNINGS.has(w));
    }
  });
}

/** Consecutive failing samples merge into one dip, from the first failure to the next good sample. */
function dipsOf(samples: readonly HealthSample[], bad: readonly (boolean | null)[], intervalMs: number): Dip[] {
  const out: Dip[] = [];
  let start: number | null = null;
  let last = 0;
  for (let i = 0; i < samples.length; i++) {
    const at = (samples[i] as HealthSample).atMs;
    if (bad[i] === true) {
      start ??= at;
      last = at;
    } else if (start !== null) {
      out.push({ atMs: start, seconds: Math.max(1, Math.round((at - start) / 1000)) });
      start = null;
    }
  }
  if (start !== null) out.push({ atMs: start, seconds: Math.max(1, Math.round((last - start + intervalMs) / 1000)) });
  return out;
}

/**
 * Every ingest check over the samples so far, oldest first. Empty while there is no sample (the
 * checklist shows the checks as pending). `targetKbps` defaults to the median ingest bitrate.
 */
export function ingestChecks(
  samples: readonly HealthSample[],
  opts: { targetKbps?: number; sampleIntervalMs?: number } = {},
): IngestCheck[] {
  if (samples.length === 0) return [];
  const sorted = [...samples].sort((a, b) => a.atMs - b.atMs);
  const target = opts.targetKbps ?? median(sorted.map((s) => s.bitrateKbps));
  const intervalMs = opts.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  return INGEST_CHECKS.map((check) => {
    const dips = dipsOf(sorted, failures(sorted, check, target), intervalMs);
    return { check, ok: dips.length === 0, dips };
  });
}
