// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Who may do what to a proposal, as a pure decision over facts the handler gathered under its
 * locks (unit-tested as a matrix). Platform roles are checked earlier by `decideAccess`; these are
 * the co-op roles: member, author, electorate member and seated council member. The triggers
 * enforce the same rules again (ADR 0004).
 */
import type { PROPOSAL_STATUSES } from "@commonair/contracts/enums";
import { proposalVisibleTo, votingOpen } from "./views.ts";

type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export type ProposalAction = "edit" | "submit" | "withdraw" | "comment" | "vote" | "councilRespond";

export interface ActionFacts {
  proposal: {
    authorId: string;
    status: ProposalStatus;
    votingStartsAt: Date | null;
    votingEndsAt: Date | null;
  };
  callerId: string;
  /** Holds any active membership. */
  member: boolean;
  /** In the proposal's frozen electorate. */
  inElectorate: boolean;
  /** Seated in the current council term. */
  seated: boolean;
  /** The council already responded. */
  responded: boolean;
  now: Date;
}

export type Refusal =
  | { code: "NOT_FOUND"; message: string }
  | { code: "FORBIDDEN"; message: string; reason?: "not_in_electorate" }
  | { code: "CONFLICT"; message: string; reason?: "voting_closed" }
  | { code: "PRECONDITION_FAILED"; message: string; requirement: "membership" };

const COMMENTS_OPEN: readonly ProposalStatus[] = ["discussion", "council_review", "voting"];
const WITHDRAWABLE: readonly ProposalStatus[] = ["draft", "discussion", "council_review"];

/** Null when allowed, else the refusal the API returns. */
export function refuseProposalAction(action: ProposalAction, f: ActionFacts): Refusal | null {
  const p = f.proposal;
  if (!proposalVisibleTo(p, f.callerId)) return { code: "NOT_FOUND", message: "Proposal not found" };
  const author = p.authorId === f.callerId;
  switch (action) {
    case "edit":
      if (!author) return { code: "FORBIDDEN", message: "Only the author can do this" };
      if (p.status !== "draft" && p.status !== "discussion")
        return { code: "CONFLICT", message: "A proposal can be edited only as a draft or during discussion" };
      return null;
    case "submit":
      if (!author) return { code: "FORBIDDEN", message: "Only the author can do this" };
      if (p.status !== "draft") return { code: "CONFLICT", message: "Only a draft can be submitted" };
      return null;
    case "withdraw":
      if (!author) return { code: "FORBIDDEN", message: "Only the author can do this" };
      if (!WITHDRAWABLE.includes(p.status))
        return { code: "CONFLICT", message: "Voting has begun; it cannot be withdrawn" };
      return null;
    case "comment":
      if (!COMMENTS_OPEN.includes(p.status))
        return { code: "CONFLICT", message: "Comments are closed for this proposal" };
      if (!f.member)
        return { code: "PRECONDITION_FAILED", message: "Only members can comment", requirement: "membership" };
      return null;
    case "vote":
      if (!votingOpen(p, f.now))
        return { code: "CONFLICT", message: "Voting is closed for this proposal", reason: "voting_closed" };
      if (!f.inElectorate)
        return { code: "FORBIDDEN", message: "You are not in this vote's electorate", reason: "not_in_electorate" };
      return null;
    case "councilRespond":
      if (p.status !== "council_review") return { code: "CONFLICT", message: "This proposal is not in council review" };
      if (!f.seated) return { code: "FORBIDDEN", message: "Only a member of the current creator council can respond" };
      if (f.responded) return { code: "CONFLICT", message: "The council already responded to this proposal" };
      return null;
  }
}
