// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure decisions for the E7 co-op flows (rejoin, board elections), unit-tested without a DOM. The
 * API decides again on every action; these only choose what the page offers.
 */
import { t } from "../../i18n/index.ts";
import { errorCode } from "../../lib/api.ts";
import type { ElectionDto, MemberClass, MembershipViewDto } from "../../lib/coop.ts";

/**
 * `membership-rejoin-viewer` is offered when there is no active viewer membership, the latest one
 * was a voluntary exit, and a subscription qualifies now (`coop.join` needs exactly that; a member
 * by share rejoins by buying a share).
 */
export function canRejoinViewer(view: Pick<MembershipViewDto, "memberships" | "eligibility"> | null): boolean {
  if (!view) return false;
  const rows = view.memberships.filter((m) => m.class === "viewer");
  if (rows.length === 0 || rows.some((m) => m.status === "active")) return false;
  // The view lists the latest ended row per class.
  if (rows[0]?.status !== "exited") return false;
  const e = view.eligibility.find((x) => x.class === "viewer");
  return e?.eligible === true && e.basis === "subscription";
}

/** The classes the caller holds now (an election's electorate and candidates are its class's members). */
export function activeMemberClasses(view: Pick<MembershipViewDto, "memberships"> | null): MemberClass[] {
  return (view?.memberships ?? []).filter((m) => m.status === "active").map((m) => m.class);
}

export type ElectionRole =
  /** Signed out, or the election is closed: read-only. */
  | { kind: "none" }
  /** Signed in but not a member of the election's class. */
  | { kind: "notMember" }
  /** Nominating, a member of the class, not yet standing. */
  | { kind: "canNominate" }
  /** Nominating and already a candidate. */
  | { kind: "standing" }
  /** Voting and a member of the class: the approval ballot. */
  | { kind: "canVote" };

/** What an election offers the caller. */
export function electionRole(
  e: Pick<ElectionDto, "class" | "status" | "candidates">,
  meId: string | null,
  classes: readonly MemberClass[],
): ElectionRole {
  if (meId === null || (e.status !== "nominating" && e.status !== "voting")) return { kind: "none" };
  if (!classes.includes(e.class)) return { kind: "notMember" };
  if (e.status === "voting") return { kind: "canVote" };
  return e.candidates.some((c) => c.user.id === meId) ? { kind: "standing" } : { kind: "canNominate" };
}

/**
 * Toggle a candidate on an approval ballot of `seats`: unchecking always works, checking only
 * while fewer than `seats` are approved (the API refuses more).
 */
export function toggleApproval(selected: readonly string[], candidateId: string, seats: number): string[] {
  if (selected.includes(candidateId)) return selected.filter((id) => id !== candidateId);
  if (selected.length >= seats) return [...selected];
  return [...selected, candidateId];
}

export type ElectionRefusal = "closed" | "alreadyCandidate" | "alreadyVoted" | "notMember" | "tooMany" | "other";

/**
 * Why `coop.elections.nominate`/`vote` was refused. The API's CONFLICT covers both "closed" and
 * "already", told apart by its fixed (English, ours) message.
 */
export function electionRefusal(err: unknown): ElectionRefusal {
  const code = errorCode(err);
  const message = err instanceof Error ? err.message : "";
  if (code === "FORBIDDEN") return "notMember";
  if (code === "CONFLICT") {
    if (/already a candidate/i.test(message)) return "alreadyCandidate";
    if (/already voted/i.test(message)) return "alreadyVoted";
    return "closed";
  }
  if (code === "BAD_REQUEST" && /at most/i.test(message)) return "tooMany";
  return "other";
}

/** The inline text for a refusal (keys are literal so the catalog check sees them). */
export function electionRefusalText(r: ElectionRefusal, seats: number): string {
  switch (r) {
    case "closed":
      return t("coop.elections.errorClosed");
    case "alreadyCandidate":
      return t("coop.elections.errorAlreadyCandidate");
    case "alreadyVoted":
      return t("coop.elections.errorAlreadyVoted");
    case "notMember":
      return t("coop.elections.errorNotMember");
    case "tooMany":
      return t("coop.elections.errorTooMany", { seats });
    case "other":
      return t("coop.elections.errorFailed");
  }
}
