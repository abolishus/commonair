// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `moderation.review` decision rules (docs/testing/e4c-selectors.md "Mod review"). Pure, so every
 * transition is unit-tested; the route applies the plan in one transaction with a
 * compare-and-set on `status = 'open'`.
 */
import type { MODERATION_REVIEW_DECISIONS, ModerationTier } from "@commonair/contracts/enums";

export type ReviewDecision = (typeof MODERATION_REVIEW_DECISIONS)[number];

export interface ReviewPlan {
  status: "cleared" | "actioned" | "open";
  /** Lift the T1 broadcast restriction this case holds. */
  liftRestriction: boolean;
  /** End the subject broadcast if it is still live. */
  endStream: boolean;
  suspend: boolean;
  notifyOwner: boolean;
  /** Move the case to tier t0, origin human (only `legal` sees it from then on). */
  escalate: boolean;
}

export type ReviewCheck =
  | { ok: true; plan: ReviewPlan }
  /** T0 cases do not exist for moderators. */
  | { ok: false; code: "NOT_FOUND" | "CONFLICT"; message: string };

export function planReview(c: { tier: ModerationTier; status: string }, decision: ReviewDecision): ReviewCheck {
  if (c.tier === "t0") return { ok: false, code: "NOT_FOUND", message: "Case not found" };
  if (c.tier !== "t1") return { ok: false, code: "CONFLICT", message: "Labels are reviewed through appeals" };
  if (c.status !== "open") return { ok: false, code: "CONFLICT", message: "This case is already decided" };
  const base = { liftRestriction: false, endStream: false, suspend: false, notifyOwner: false, escalate: false };
  switch (decision) {
    case "clear":
      return { ok: true, plan: { ...base, status: "cleared", liftRestriction: true } };
    case "warn":
      return { ok: true, plan: { ...base, status: "actioned", liftRestriction: true, notifyOwner: true } };
    case "end_stream":
      return { ok: true, plan: { ...base, status: "actioned", endStream: true } };
    case "suspend":
      return { ok: true, plan: { ...base, status: "actioned", endStream: true, suspend: true, notifyOwner: true } };
    case "escalate_legal":
      return { ok: true, plan: { ...base, status: "open", escalate: true } };
  }
}

/** Audit actor type of a staff member (ACTOR_TYPES has no `legal`: legal staff act as moderators). */
export const staffActorType = (role: string): "admin" | "moderator" => (role === "admin" ? "admin" : "moderator");
