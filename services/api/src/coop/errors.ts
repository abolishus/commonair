// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Trigger refusals (0001, 0002, 0021) mapped to the contract's error codes. The database is the
 * enforcement layer (ADR 0004); handlers check first for clear errors, and anything that still
 * reaches a trigger (a race, a stale read) is translated here. The trigger's message text never
 * reaches the client: each rule maps to a fixed message of ours.
 */
import { ORPCError } from "@orpc/server";
import { apiError, pgCode } from "../lib/errors.ts";
import { violatesConstraint } from "../money/checkout-shared.ts";

type Mapped = ORPCError<string, unknown>;

/** The driver's message for an error or anything in its cause chain. */
export function pgMessage(err: unknown): string {
  let e: unknown = err;
  for (let depth = 0; e && depth < 5; depth++) {
    const x = e as { code?: unknown; message?: unknown };
    if (typeof x.code === "string" && /^[0-9A-Z]{5}$/.test(x.code) && typeof x.message === "string") return x.message;
    e = (e as { cause?: unknown }).cause;
  }
  return "";
}

/** Rules in order: the first whose pattern matches the trigger message wins. */
const RULES: readonly { match: RegExp; map: () => Mapped }[] = [
  // Votes (commonair_vote_guard)
  {
    match: /is not in the electorate for proposal/,
    map: () => apiError("FORBIDDEN", "You are not in this vote's electorate", { reason: "not_in_electorate" }),
  },
  {
    match: /voting is not open for proposal/,
    map: () => apiError("CONFLICT", "Voting is closed for this proposal", { reason: "voting_closed" }),
  },
  // Proposals (commonair_proposal_guard)
  {
    match: /proposal changes must name existing settings/,
    map: () => apiError("BAD_REQUEST", "Each change must name an existing setting, once"),
  },
  {
    match: /changing protected settings must be kind=protected|protected proposals always go through/,
    map: () => apiError("BAD_REQUEST", "Protected changes must be a protected proposal that affects creators"),
  },
  {
    match: /content is frozen once review or voting begins/,
    map: () => apiError("CONFLICT", "This proposal can no longer be edited"),
  },
  { match: /proposal status cannot go from/, map: () => apiError("CONFLICT", "This proposal is not in that state") },
  { match: /the discussion period has not ended/, map: () => apiError("CONFLICT", "Discussion has not ended yet") },
  // Comments (commonair_proposal_comment_guard)
  {
    match: /comments are open only during/,
    map: () => apiError("CONFLICT", "Comments are closed for this proposal"),
  },
  {
    match: /only members comment on proposals/,
    map: () => apiError("PRECONDITION_FAILED", "Only members can comment", { requirement: "membership" }),
  },
  // Council responses (commonair_council_response_guard)
  {
    match: /council responds only while a proposal is in council review/,
    map: () => apiError("CONFLICT", "This proposal is not in council review"),
  },
  {
    match: /only the current council term can respond|only a seated council member/,
    map: () => apiError("FORBIDDEN", "Only a member of the current creator council can respond"),
  },
  {
    match: /council responses are final/,
    map: () => apiError("CONFLICT", "The council already responded to this proposal"),
  },
  // Member shares (commonair_share_guard)
  { match: /already has an open share/, map: () => apiError("CONFLICT", "You already have a member share") },
  {
    match: /a member share cannot go from|share is held only once|share is refunded only once/,
    map: () => apiError("CONFLICT", "This share changed; reload and try again"),
  },
  // Patronage (commonair_patronage_period_guard)
  {
    match: /must be approved by someone other than the person who ran it/,
    map: () =>
      apiError("FORBIDDEN", "Someone other than the person who ran it must approve", { reason: "second_approver" }),
  },
  {
    match: /approved by a treasurer or an admin/,
    map: () => apiError("FORBIDDEN", "Only a treasurer or an admin can approve"),
  },
  {
    match:
      /only a computed patronage period can be approved|approved patronage period is frozen|figures of an approved period are frozen/,
    map: () => apiError("CONFLICT", "This patronage period is not open to that change"),
  },
  // Settings (only the worker applies decisions; the API never writes them)
  {
    match: /can only change by applying a passed proposal|needs a protected decision/,
    map: () => apiError("FORBIDDEN", "Settings change only by an applied decision"),
  },
];

/** Constraint names whose unique violation means "already done". */
const CONFLICTS: Readonly<Record<string, string>> = {
  memberships_active_uq: "That membership is already active",
  membership_shares_held_uq: "You already have a member share",
  council_responses_pkey: "The council already responded to this proposal",
  votes_one_per_member_uq: "Your vote changed concurrently; try again",
  election_candidates_election_id_user_id_pk: "You are already a candidate",
  election_ballots_election_id_voter_id_pk: "You already voted in this election",
  patronage_periods_uq: "That patronage period already exists",
};

function constraintOf(err: unknown): string | undefined {
  let e: unknown = err;
  for (let depth = 0; e && depth < 5; depth++) {
    const x = e as { constraint_name?: unknown; constraint?: unknown };
    const name = typeof x.constraint_name === "string" ? x.constraint_name : x.constraint;
    if (typeof name === "string") return name;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The client error for a database refusal, or null when `err` is not one (it is then rethrown and
 * reported as an internal error without detail).
 */
export function mapCoopDbError(err: unknown): Mapped | null {
  if (err instanceof ORPCError) return null;
  const code = pgCode(err);
  if (!code) return null;
  const message = pgMessage(err);
  for (const r of RULES) if (r.match.test(message)) return r.map();
  if (code === "23505") return apiError("CONFLICT", CONFLICTS[constraintOf(err) ?? ""] ?? "Already exists");
  // Any other trigger refusal: never echo the SQL message.
  if (code === "42501") return apiError("FORBIDDEN", "The database refused this change");
  if (code === "23514" || code === "P0001") return apiError("CONFLICT", "Conflicts with the current state");
  return null;
}

/** Run `fn`, translating database refusals; everything else passes through unchanged. */
export async function withCoopErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const mapped = mapCoopDbError(err);
    if (mapped) throw mapped;
    throw err;
  }
}

/**
 * `withCoopErrors`, running `fn` again (up to `retries` more times) when it fails on the unique
 * `constraint`. The check sees the raw database error: once mapped, the constraint is gone.
 */
export async function withCoopErrorsRetrying<T>(constraint: string, fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < retries && violatesConstraint(err, constraint)) continue;
      const mapped = mapCoopDbError(err);
      if (mapped) throw mapped;
      throw err;
    }
  }
}
