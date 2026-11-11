// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Your first vote", picked from the real electorate (overhaul wave 2 journey gap). A proposal's
 * electorate is frozen when its voting opens (`packages/governance`), so a new member cannot vote
 * on one already open: `canVote` from the API is the only honest signal. The note names the first
 * open proposal the caller can still vote on; otherwise it says votes come with the proposals that
 * open from now on, naming the next one to open when its date is known. Only a new member who has
 * not voted yet is told "first" and "from now on"; anyone else gets the neutral wording, and someone
 * who voted on every ballot open to them is told so instead of the joined-late line.
 */
import { RelativeTime } from "@commonair/ui";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import type { ProposalDto } from "../../lib/coop.ts";
import { useCoopLoad } from "./use-coop.ts";

type Proposal = Pick<ProposalDto, "id" | "title" | "status" | "canVote" | "myVote" | "timeline">;

export type FirstVoteChoice = {
  /** The caller has a recorded vote on one of the proposals read, so no vote of theirs is a first. */
  votedBefore: boolean;
} &
  /** Open now, and the caller is in its electorate and has not voted yet. */
  (
    | { kind: "vote"; proposal: Proposal; closesAt: string | null }
    /**
     * Nothing to vote on yet: the next proposal to open, with its opening time when known.
     * `votedAllOpen`: some ballot is open to the caller and they voted on every one.
     */
    | { kind: "next"; proposal: Proposal; opensAt: string | null; votedAllOpen: boolean }
    /** Nothing open to the caller and nothing coming. */
    | { kind: "none"; votedAllOpen: boolean }
  );

const time = (iso: string | null): number => (iso ? Date.parse(iso) : Number.NaN);

/** When a proposal still in discussion or council review opens for voting, as far as is known. */
export function opensAt(p: Pick<ProposalDto, "status" | "timeline">): string | null {
  if (p.status === "council_review") return p.timeline.votingStartsAt ?? p.timeline.councilReviewEndsAt;
  if (p.status === "discussion") return p.timeline.votingStartsAt ?? p.timeline.discussionEndsAt;
  return null;
}

/**
 * The first vote for `proposals` at `nowMs` (pure). Voting proposals the caller can vote on and
 * has not voted on come first, the one closing soonest; then the next proposal to open, soonest
 * known opening first (a past or unknown date sorts last and shows no date).
 */
export function pickFirstVote(proposals: readonly Proposal[], nowMs: number): FirstVoteChoice {
  const votedBefore = proposals.some((p) => p.myVote !== null);
  const ballots = proposals
    .filter((p) => p.status === "voting" && p.canVote)
    .filter((p) => !(time(p.timeline.votingEndsAt) <= nowMs));
  const open = ballots
    .filter((p) => p.myVote === null)
    .toSorted((a, b) => (time(a.timeline.votingEndsAt) || Infinity) - (time(b.timeline.votingEndsAt) || Infinity));
  const first = open[0];
  if (first) return { kind: "vote", proposal: first, closesAt: first.timeline.votingEndsAt, votedBefore };
  const votedAllOpen = ballots.length > 0;
  const upcoming = proposals
    .filter((p) => p.status === "discussion" || p.status === "council_review")
    .map((p) => {
      const at = opensAt(p);
      const ms = time(at);
      return { p, at: ms > nowMs ? at : null, ms: ms > nowMs ? ms : Infinity };
    })
    .toSorted((a, b) => a.ms - b.ms);
  const next = upcoming[0];
  if (next) return { kind: "next", proposal: next.p, opensAt: next.at, votedBefore, votedAllOpen };
  return { kind: "none", votedBefore, votedAllOpen };
}

/**
 * Why the ballot is closed to the caller on a proposal in voting (pure): signed out; a member who
 * joined after voting opened (the frozen electorate); someone who is not a member; or, when the
 * membership could not be read (`member` null), the neutral electorate line.
 */
export function cannotVoteReason(o: { signedIn: boolean; member: boolean | null }): string {
  if (!o.signedIn) return t("coop.vote.signIn");
  if (o.member === true) return t("d2Membership.vote.joinedAfter");
  if (o.member === false) return t("d2Membership.vote.notMember");
  return t("coop.vote.notInElectorate");
}

/** Proposals per status the note reads (the same pages `/coop` shows). */
export const FIRST_VOTE_LIMIT = 20;

/** What the note loads (tests pass a stub). */
export type FirstVoteLoader = () => Promise<Proposal[]>;

export const loadOpenProposals: FirstVoteLoader = async () => {
  const pages = await Promise.all(
    (["voting", "council_review", "discussion"] as const).map((status) =>
      api().coop.proposals.list({ status, limit: FIRST_VOTE_LIMIT }),
    ),
  );
  return pages.flatMap((page) => page.items);
};

/**
 * The caller's first vote once `enabled` (a member, or a welcome that just started one); null
 * while loading, disabled, or when the proposals did not load (the note is extra, never a gate).
 */
export function useFirstVote(
  enabled: boolean,
  key: string,
  load: FirstVoteLoader = loadOpenProposals,
): FirstVoteChoice | null {
  // The clock is read once per answer, when it arrives, so a render never flips the choice.
  const choice = useCoopLoad(enabled ? `first-vote|${key}` : "first-vote|-", () =>
    enabled ? load().then((proposals) => pickFirstVote(proposals, Date.now())) : Promise.resolve(null),
  );
  return choice.data;
}

const proposalLink = (p: Proposal) => (
  <Link
    to="/coop/proposals/$id"
    params={{ id: p.id }}
    data-testid="first-vote-link"
    className="font-medium text-foreground underline underline-offset-4"
  >
    {p.title}
  </Link>
);

/** Members who joined this recently still count as new on the membership page. */
export const NEW_MEMBER_DAYS = 30;

/**
 * Whether the caller's membership is new at `nowMs` (pure): their earliest active membership began
 * within `NEW_MEMBER_DAYS`. A long-standing member who later gained another class is not new.
 */
export function isNewMember(
  memberships: readonly { status: string; joinedAt: string }[] | null | undefined,
  nowMs: number,
): boolean {
  const joined = (memberships ?? []).filter((m) => m.status === "active").map((m) => Date.parse(m.joinedAt));
  if (joined.length === 0) return false;
  return nowMs - Math.min(...joined) <= NEW_MEMBER_DAYS * 86_400_000;
}

/**
 * The note itself; nothing while `choice` is null. `newMember` (the welcome always is) allows the
 * "first vote" and "from now on" wording; it is dropped once the caller has voted.
 */
export function FirstVoteNote({
  choice,
  newMember = true,
  ...props
}: { choice: FirstVoteChoice | null; newMember?: boolean } & React.ComponentProps<"div">): React.JSX.Element | null {
  if (!choice) return null;
  const first = newMember && !choice.votedBefore;
  return (
    <div
      data-testid="first-vote"
      data-kind={choice.kind}
      data-first={first ? "true" : "false"}
      className="flex flex-col gap-1 text-sm"
      {...props}
    >
      {choice.kind === "vote" ? (
        <>
          <p>
            {t(first ? "d2Membership.firstVote.open" : "d2Membership.firstVote.openForYou")}{" "}
            {proposalLink(choice.proposal)}
          </p>
          {choice.closesAt && (
            <p className="text-muted-foreground">
              {t("d2Membership.firstVote.closes")} <RelativeTime date={choice.closesAt} />
            </p>
          )}
        </>
      ) : (
        <>
          {choice.votedAllOpen ? (
            <p>{t("d2Membership.firstVote.votedAll")}</p>
          ) : (
            first && <p>{t("d2Membership.firstVote.fromNow")}</p>
          )}
          {choice.kind === "next" ? (
            <>
              <p className="text-muted-foreground">
                {t("d2Membership.firstVote.next")} {proposalLink(choice.proposal)}
              </p>
              {choice.opensAt && (
                <p className="text-muted-foreground">
                  {t("d2Membership.firstVote.opens")} <RelativeTime date={choice.opensAt} />
                </p>
              )}
            </>
          ) : (
            !choice.votedAllOpen && <p className="text-muted-foreground">{t("d2Membership.firstVote.nothingOpen")}</p>
          )}
        </>
      )}
    </div>
  );
}
