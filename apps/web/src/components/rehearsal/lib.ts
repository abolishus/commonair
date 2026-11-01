// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure helpers for the rehearse page (W2-rehearsal; docs/testing/w2-selectors.md "Rehearsal"):
 * the page state, the countdown, the checklist and the refusal messages.
 */
import type { RehearsalReport, RehearsalStatus } from "@commonair/contracts/dto";
import { REHEARSAL_RULES } from "@commonair/contracts/enums";
import type { MessageKey } from "../../i18n/index.ts";
import { errorCode } from "../../lib/api.ts";
import { errorRequirement } from "../../lib/coop.ts";

export const MAX_INVITEES = REHEARSAL_RULES.maxInvitees;
/** The brief: the page polls `status` and `report` every 5 s. */
export const REHEARSAL_POLL_MS = 5_000;

/** `rehearsal-status` `data-state`: `ended` is idle with a finished report to read. */
export type ViewState = "idle" | "armed" | "rehearsing" | "ended";

export function viewState(status: RehearsalStatus | null, report: RehearsalReport | null): ViewState {
  if (status?.state === "rehearsing") return "rehearsing";
  if (status?.state === "armed") return "armed";
  return report?.endReason ? "ended" : "idle";
}

/** Seconds until the arm lapses (armed) or the cap ends the rehearsal (rehearsing); null otherwise. */
export function remainingSeconds(status: RehearsalStatus | null, nowMs: number): number | null {
  const until = status?.state === "armed" ? status.armExpiresAt : status?.state === "rehearsing" ? status.endsAt : null;
  if (!until) return null;
  return Math.max(0, Math.ceil((Date.parse(until) - nowMs) / 1000));
}

/** `rehearsal-report` `data-ended-by`. */
export type EndedBy = "owner" | "cap" | "publisher" | "safety" | "expired";
const ENDED_BY: Record<NonNullable<RehearsalReport["endReason"]>, EndedBy> = {
  disarmed: "owner",
  cap: "cap",
  publisher_ended: "publisher",
  safety: "safety",
  expired: "expired",
};
export const endedBy = (reason: RehearsalReport["endReason"]): EndedBy | null => (reason ? ENDED_BY[reason] : null);

export const ENDED_BY_KEYS: Record<EndedBy, MessageKey> = {
  owner: "rehearsal.report.endedBy.owner",
  cap: "rehearsal.report.endedBy.cap",
  publisher: "rehearsal.report.endedBy.publisher",
  safety: "rehearsal.report.endedBy.safety",
  expired: "rehearsal.report.endedBy.expired",
};

type RuleCounts = RehearsalReport["chat"]["held"];
export const RULES = [
  "wordFilter",
  "link",
  "duplicate",
  "rateLimit",
  "other",
] as const satisfies readonly (keyof RuleCounts)[];
export const RULE_KEYS: Record<(typeof RULES)[number], MessageKey> = {
  wordFilter: "rehearsal.report.rule.wordFilter",
  link: "rehearsal.report.rule.link",
  duplicate: "rehearsal.report.rule.duplicate",
  rateLimit: "rehearsal.report.rule.rateLimit",
  other: "rehearsal.report.rule.other",
};
export const total = (c: RuleCounts) => RULES.reduce((n, r) => n + c[r], 0);

/** `rehearsal-check` `data-check`: the six ingest checks, the chat filters and safety sampling. */
export const CHECKS = [
  "bitrate",
  "fps",
  "keyframe_interval",
  "dropped_frames",
  "audio",
  "video",
  "chat",
  "moderation",
] as const;
export type CheckName = (typeof CHECKS)[number];
export type CheckState = "pending" | "ok" | "warn";
export const CHECK_KEYS: Record<CheckName, MessageKey> = {
  bitrate: "rehearsal.check.bitrate",
  fps: "rehearsal.check.fps",
  keyframe_interval: "rehearsal.check.keyframe_interval",
  dropped_frames: "rehearsal.check.dropped_frames",
  audio: "rehearsal.check.audio",
  video: "rehearsal.check.video",
  chat: "rehearsal.check.chat",
  moderation: "rehearsal.check.moderation",
};
export const CHECK_STATE_KEYS: Record<CheckState, MessageKey> = {
  pending: "rehearsal.checkState.pending",
  ok: "rehearsal.checkState.ok",
  warn: "rehearsal.checkState.warn",
};

export interface ChecklistItem {
  check: CheckName;
  state: CheckState;
}

/**
 * Every check, `pending` until it has something to judge: ingest until the first health sample,
 * chat until a filter caught a simulated message, safety sampling until ingest has samples.
 */
export function checklist(report: RehearsalReport | null): ChecklistItem[] {
  const ingest = new Map((report?.ingest ?? []).map((c) => [c.check, c]));
  return CHECKS.map((check): ChecklistItem => {
    if (check === "chat") {
      const caught = report ? total(report.chat.held) + total(report.chat.rejected) : 0;
      return { check, state: caught > 0 ? "ok" : "pending" };
    }
    if (check === "moderation") {
      if (report?.moderation.flagged) return { check, state: "warn" };
      return { check, state: ingest.size > 0 ? "ok" : "pending" };
    }
    const c = ingest.get(check);
    return { check, state: c ? (c.ok ? "ok" : "warn") : "pending" };
  });
}

export interface DipRow {
  /** `data-kind`: the check that dipped. */
  kind: RehearsalReport["ingest"][number]["check"];
  at: string;
  /** Seconds after the rehearsal started (the report shows it as a clock). */
  offsetSeconds: number;
  seconds: number;
}

/** Every timed dip, in time order. */
export function dips(report: RehearsalReport): DipRow[] {
  const start = Date.parse(report.startedAt);
  return report.ingest
    .flatMap((c) =>
      c.dips.map((d) => ({
        kind: c.check,
        at: d.at,
        offsetSeconds: Math.max(0, Math.round((Date.parse(d.at) - start) / 1000)),
        seconds: d.seconds,
      })),
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Refusals of `arm` (`PRECONDITION_FAILED` requirement) → a message. */
export function armErrorKey(err: unknown): MessageKey {
  if (errorCode(err) === "PRECONDITION_FAILED") {
    const r = errorRequirement(err);
    if (r === "live") return "rehearsal.refusal.live";
    if (r === "suspended") return "rehearsal.refusal.suspended";
    if (r === "armed") return "rehearsal.refusal.armed";
    if (r === "rehearsing") return "rehearsal.refusal.rehearsing";
  }
  return "rehearsal.armFailed";
}

export function inviteErrorKey(err: unknown): MessageKey {
  if (errorCode(err) === "PRECONDITION_FAILED") {
    const r = errorRequirement(err);
    if (r === "invitee_limit") return "rehearsal.invitees.limit";
    if (r === "not_follower") return "rehearsal.invitees.notFollower";
    if (r === "not_armed") return "rehearsal.invitees.notArmed";
  }
  return "rehearsal.invitees.failed";
}

/** A follower the picker may still suggest: not excluded, not already invited. */
export function suggestions(
  followers: readonly { username: string; excluded: boolean }[],
  invited: readonly { username: string }[],
): string[] {
  const taken = new Set(invited.map((i) => i.username));
  return followers.filter((f) => !f.excluded && !taken.has(f.username)).map((f) => f.username);
}
