// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Co-op governance mail. Member-wide announcements (vote opened, result)
 * carry an unsubscribe link and List-Unsubscribe; council review requests
 * are duty mail to council members and do not.
 */
import type { PROPOSAL_STATUSES } from "@commonair/contracts/enums";
import type { DateInput } from "../format.ts";
import { Action, defineTemplate, Facts, H1, Muted, P } from "../template.tsx";

export interface GovernanceVoteOpenedData {
  proposalTitle: string;
  closesAt: DateInput;
  voteUrl: string;
  unsubscribeUrl: string;
}

export const governanceVoteOpened = defineTemplate("governanceVoteOpened", {
  links: ["voteUrl", "unsubscribeUrl"],
  subject: (ctx, d: GovernanceVoteOpenedData) => ctx.text(ctx.messages.subject, { proposal: d.proposalTitle }),
  unsubscribeUrl: (d: GovernanceVoteOpenedData) => d.unsubscribeUrl,
  body: (ctx, d: GovernanceVoteOpenedData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body, { proposal: <strong>{d.proposalTitle}</strong> })}</P>
        <Facts items={[[m.closesLabel, ctx.dateTime(d.closesAt)]]} />
        <P>{ctx.t(m.why)}</P>
        <Action ctx={ctx} href={d.voteUrl} label={m.action} />
      </>
    );
  },
});

export interface GovernanceResultPublishedData {
  proposalTitle: string;
  outcome: Extract<(typeof PROPOSAL_STATUSES)[number], "passed" | "rejected">;
  /** Share of eligible members who voted, 0..1. */
  turnout: number;
  resultUrl: string;
  unsubscribeUrl: string;
}

export const governanceResultPublished = defineTemplate("governanceResultPublished", {
  links: ["resultUrl", "unsubscribeUrl"],
  subject: (ctx, d: GovernanceResultPublishedData) => ctx.text(ctx.messages.subject, { proposal: d.proposalTitle }),
  unsubscribeUrl: (d: GovernanceResultPublishedData) => d.unsubscribeUrl,
  body: (ctx, d: GovernanceResultPublishedData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body, { proposal: <strong>{d.proposalTitle}</strong> })}</P>
        <Facts
          items={[
            [m.outcomeLabel, d.outcome === "passed" ? m.outcomePassed : m.outcomeRejected],
            [m.turnoutLabel, ctx.percent(d.turnout)],
          ]}
        />
        <Action ctx={ctx} href={d.resultUrl} label={m.action} />
      </>
    );
  },
});

/** Sent to creator-council members when a proposal that affects creators enters council review. */
export interface CouncilReviewRequestedData {
  proposalTitle: string;
  reviewEndsAt: DateInput;
  respondUrl: string;
}

export const councilReviewRequested = defineTemplate("councilReviewRequested", {
  links: ["respondUrl"],
  subject: (ctx, d: CouncilReviewRequestedData) => ctx.text(ctx.messages.subject, { proposal: d.proposalTitle }),
  body: (ctx, d: CouncilReviewRequestedData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body, { proposal: <strong>{d.proposalTitle}</strong> })}</P>
        <Facts items={[[m.dueLabel, ctx.dateTime(d.reviewEndsAt)]]} />
        <P>{ctx.t(m.duty)}</P>
        <Action ctx={ctx} href={d.respondUrl} label={m.action} />
        <Muted>{ctx.t(m.public)}</Muted>
      </>
    );
  },
});
