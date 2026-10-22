// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Status → badge tone for the co-op enums (contracts `enums.ts`). The badge text always says the
 * state in words; the tone only reinforces it. Unknown values fall back to `neutral`.
 */
import type { StatusTone } from "../../primitives/status-badge.tsx";

const pick =
  (map: Record<string, StatusTone>) =>
  (value: string | null | undefined): StatusTone =>
    (value ? map[value] : undefined) ?? "neutral";

/** `PROPOSAL_STATUSES`. */
export const proposalStatusTone = pick({
  draft: "neutral",
  discussion: "neutral",
  council_review: "warning",
  voting: "info",
  passed: "success",
  applied: "success",
  rejected: "danger",
  withdrawn: "neutral",
});

/** `SHARE_STATUSES`, plus `none` (no share yet). */
export const shareStatusTone = pick({
  none: "neutral",
  pending: "warning",
  held: "success",
  refund_pending: "warning",
  refunded: "neutral",
  cancelled: "neutral",
});

/** `MEMBERSHIP_STATUSES`. */
export const membershipStatusTone = pick({ active: "success", lapsed: "warning", exited: "neutral" });

/** `PATRONAGE_STATUSES`. */
export const patronageStatusTone = pick({
  draft: "neutral",
  computed: "warning",
  approved: "success",
  distributed: "success",
});

/** `COUNCIL_STANCES`. */
export const councilStanceTone = pick({ support: "success", oppose: "danger", mixed: "warning", neutral: "neutral" });

/** `ELECTION_STATUSES`. */
export const electionStatusTone = pick({ nominating: "info", voting: "info", closed: "neutral" });
