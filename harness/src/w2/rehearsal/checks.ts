// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure judgements of the `rehearsal` scenario (W2-rehearsal): what the report must show once the
 * simulated chat and its burst ran, and the rehearsal VOD's 24 h expiry with a tolerance for a
 * loaded CI runner. The test ids and routes it reads are docs/testing/w2-selectors.md "Rehearsal".
 */
import type { RehearsalReport } from "@commonair/contracts/dto";
import { REHEARSAL_RULES } from "@commonair/contracts/enums";

export const REHEARSAL_ROUTE = "/rehearse";
export const REHEARSAL_TEST_IDS = {
  page: "rehearse-page",
  status: "rehearsal-status",
  arm: "rehearsal-arm",
  disarm: "rehearsal-disarm",
  disarmConfirm: "rehearsal-disarm-confirm",
  keyReminder: "rehearsal-key-reminder",
  inviteeInput: "rehearsal-invitee-input",
  inviteeAdd: "rehearsal-invitee-add",
  invitee: "rehearsal-invitee",
  inviteeRemove: "rehearsal-invitee-remove",
  inviteeLimit: "rehearsal-invitee-limit",
  checklist: "rehearsal-checklist",
  check: "rehearsal-check",
  player: "rehearsal-player",
  report: "rehearsal-report",
  reportChat: "rehearsal-report-chat",
  reportIngest: "rehearsal-report-ingest",
  reportDip: "rehearsal-report-dip",
  watch: "rehearsal-watch",
} as const;

/** `[data-testid="…"]` with optional `data-*` attributes. */
export function testIdSelector(id: string, data: Record<string, string> = {}): string {
  const attrs = Object.entries(data)
    .map(([k, v]) => `[data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${v}"]`)
    .join("");
  return `[data-testid="${id}"]${attrs}`;
}

const sum = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);

export interface ChatReportVerdict {
  ok: boolean;
  /** What is missing, for the report. */
  missing: string[];
  accepted: number;
  held: number;
  rejected: number;
}

/**
 * The simulated chat ran through the real filters: messages were accepted, the channel's filter
 * word was held (the scenario's filter holds), links were refused (the scenario blocks links), and
 * the burst's repeats were caught as duplicates or by the rate limit.
 */
export function judgeChatReport(r: RehearsalReport["chat"], minAccepted = 30): ChatReportVerdict {
  const missing: string[] = [];
  if (r.accepted < minAccepted) missing.push(`accepted ≥ ${minAccepted}`);
  if (r.held.wordFilter < 1) missing.push("held by the word filter");
  if (r.rejected.link < 1) missing.push("rejected as links");
  if (r.rejected.duplicate + r.rejected.rateLimit < 5) missing.push("burst caught as duplicates or by the rate limit");
  return { ok: missing.length === 0, missing, accepted: r.accepted, held: sum(r.held), rejected: sum(r.rejected) };
}

/** A rehearsal VOD expires `vodKeepSeconds` after it was created or ended (whichever finalize used). */
export const VOD_EXPIRY_TOLERANCE_MS = 15 * 60_000;

export function vodExpiresInADay(
  expiresAt: Date | null,
  anchors: readonly (Date | null)[],
  toleranceMs = VOD_EXPIRY_TOLERANCE_MS,
): boolean {
  if (!expiresAt) return false;
  const keepMs = REHEARSAL_RULES.vodKeepSeconds * 1000;
  return anchors.some((a) => a !== null && Math.abs(expiresAt.getTime() - (a.getTime() + keepMs)) <= toleranceMs);
}

/** A scenario-unique literal the channel filters with `hold`: the simulated chat samples it. */
export function heldWord(runTag: string): string {
  return `rehearsalword${runTag
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 8)}`;
}
