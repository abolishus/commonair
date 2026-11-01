// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Vote arithmetic at close (ADR 0038 §7). Pure. */
import type { JuryVote } from "@commonair/contracts/enums";

export interface VoteCounts {
  agree: number;
  disagree: number;
  unsure: number;
}

export function countVotes(votes: readonly { vote: JuryVote }[]): VoteCounts {
  const c: VoteCounts = { agree: 0, disagree: 0, unsure: 0 };
  for (const v of votes) c[v.vote]++;
  return c;
}

export const totalVotes = (c: VoteCounts): number => c.agree + c.disagree + c.unsure;

/**
 * Flagged for staff re-review when `disagree` votes are more than half of the votes cast on the
 * case (`unsure` counts as cast); a tie, or an even split, is not a majority. No votes, no flag.
 */
export function majorityDisagrees(c: VoteCounts): boolean {
  return c.disagree * 2 > totalVotes(c);
}
