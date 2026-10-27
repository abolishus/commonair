// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Trust & safety: copyright notices, restorations, appeal decisions, statements of reasons. The DMCA mails follow
 * 17 U.S.C. § 512 as the platform reads it; NOT REVIEWED BY A LAWYER (docs/operators/dmca.md).
 */
import type {
  APPEAL_KINDS,
  APPEAL_STATUSES,
  ENFORCEMENT_AUTOMATED_DECISIONS,
  ENFORCEMENT_CONTENT_TYPES,
  ENFORCEMENT_GROUNDS,
  ENFORCEMENT_RESTRICTION_DETAILS,
  ENFORCEMENT_RESTRICTION_KINDS,
  ENFORCEMENT_SOURCES,
  ModerationCategory,
  MODERATION_REVIEW_DECISIONS,
} from "@commonair/contracts/enums";
import type * as React from "react";
import type { DateInput } from "../format.ts";
import { Action, defineTemplate, Facts, H1, Muted, Notice, P } from "../template.tsx";

export interface DmcaNoticeReceivedData {
  contentTitle: string;
  noticeRef: string;
  receivedAt: DateInput;
  noticeUrl: string;
}

export const dmcaNoticeReceived = defineTemplate("dmcaNoticeReceived", {
  links: ["noticeUrl"],
  subject: (ctx, d: DmcaNoticeReceivedData) => ctx.text(ctx.messages.subject, { content: d.contentTitle }),
  body: (ctx, d: DmcaNoticeReceivedData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body, { content: <strong>{d.contentTitle}</strong> })}</P>
        <Facts
          items={[
            [m.noticeLabel, d.noticeRef],
            [m.receivedLabel, ctx.dateTime(d.receivedAt)],
          ]}
        />
        <P>{ctx.t(m.counter)}</P>
        <Action ctx={ctx} href={d.noticeUrl} label={m.action} />
        <Muted>{ctx.t(m.policy, { contact: ctx.contact("dmca") })}</Muted>
      </>
    );
  },
});

export interface DmcaNoticeDecidedData {
  noticeRef: string;
  decision: "actioned" | "rejected";
  decidedAt: DateInput;
  /** The moderator's note (for a rejection: what the notice lacks, § 512(c)(3)(B)(ii)). */
  note: string;
  /** For an actioned notice: how many of its locations were disabled, out of how many. */
  removedItems: number;
  totalItems: number;
}

/** Actioned with nothing (or only part) disabled must not read as a full takedown. */
function decidedBody(
  m: { bodyActioned: string; bodyActionedPartial: string; bodyActionedNone: string; bodyRejected: string },
  d: DmcaNoticeDecidedData,
) {
  if (d.decision === "rejected") return m.bodyRejected;
  if (d.removedItems <= 0) return m.bodyActionedNone;
  return d.removedItems < d.totalItems ? m.bodyActionedPartial : m.bodyActioned;
}

/** To the claimant: the notice was actioned, or rejected with what was missing. */
export const dmcaNoticeDecided = defineTemplate("dmcaNoticeDecided", {
  links: [],
  subject: (ctx, d: DmcaNoticeDecidedData) =>
    ctx.text(d.decision === "actioned" ? ctx.messages.subjectActioned : ctx.messages.subjectRejected, {
      noticeRef: d.noticeRef,
    }),
  body: (ctx, d: DmcaNoticeDecidedData) => {
    const m = ctx.messages;
    const actioned = d.decision === "actioned";
    const facts: [string, string][] = [
      [m.noticeLabel, d.noticeRef],
      [m.decidedLabel, ctx.dateTime(d.decidedAt)],
    ];
    if (d.note.trim() !== "") facts.push([m.noteLabel, d.note]);
    return (
      <>
        <H1>{ctx.t(actioned ? m.headingActioned : m.headingRejected)}</H1>
        <P>
          {ctx.t(decidedBody(m, d), {
            noticeRef: <strong>{d.noticeRef}</strong>,
            removed: String(d.removedItems),
            total: String(d.totalItems),
          })}
        </P>
        <Facts items={facts} />
        {actioned ? null : <P>{ctx.t(m.resubmit)}</P>}
        <Muted>{ctx.t(m.policy, { contact: ctx.contact("dmca") })}</Muted>
      </>
    );
  },
});

export interface DmcaCounterNoticeForwardedData {
  noticeRef: string;
  /** The counter-notifier's details, which § 512(g)(2)(B) requires the claimant to receive. */
  fullName: string;
  address: string;
  phone: string;
  statement: string;
  /** The counter-notifier's signature (§ 512(g)(3)(A)), as typed. */
  signature: string;
  /** The locations of the removed material the counter-notice covers (rendered as text). */
  items: readonly string[];
  receivedAt: DateInput;
  restoreAfter: DateInput;
}

/** To the claimant: a copy of the counter-notice and when the material comes back (§ 512(g)(2)(B)). */
export const dmcaCounterNoticeForwarded = defineTemplate("dmcaCounterNoticeForwarded", {
  links: [],
  subject: (ctx, d: DmcaCounterNoticeForwardedData) => ctx.text(ctx.messages.subject, { noticeRef: d.noticeRef }),
  body: (ctx, d: DmcaCounterNoticeForwardedData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body, { noticeRef: <strong>{d.noticeRef}</strong> })}</P>
        <Facts
          items={[
            [m.nameLabel, d.fullName],
            [m.addressLabel, d.address],
            [m.phoneLabel, d.phone],
            [m.statementLabel, d.statement],
            [m.signatureLabel, d.signature],
            [m.itemsLabel, d.items.join(", ")],
            [m.receivedLabel, ctx.dateTime(d.receivedAt)],
            [m.restoreLabel, ctx.dateTime(d.restoreAfter)],
          ]}
        />
        <P>{ctx.t(m.statements)}</P>
        <Notice>
          {ctx.t(m.restore, { restoreAfter: ctx.dateTime(d.restoreAfter), contact: ctx.contact("dmca") })}
        </Notice>
      </>
    );
  },
});

export interface ContentRestoredData {
  contentTitle: string;
  restoredAt: DateInput;
  contentUrl: string;
}

export const contentRestored = defineTemplate("contentRestored", {
  links: ["contentUrl"],
  subject: (ctx, d: ContentRestoredData) => ctx.text(ctx.messages.subject, { content: d.contentTitle }),
  body: (ctx, d: ContentRestoredData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body, { content: <strong>{d.contentTitle}</strong> })}</P>
        <Facts items={[[m.restoredLabel, ctx.dateTime(d.restoredAt)]]} />
        <Action ctx={ctx} href={d.contentUrl} label={m.action} />
      </>
    );
  },
});

type EnforcementFactsData =
  | { code: "classifier"; category: ModerationCategory; tier: "t1" | "t2"; threshold: number; capturedAt: DateInput }
  | { code: "moderator_review"; caseRef: string; decision: (typeof MODERATION_REVIEW_DECISIONS)[number] }
  | { code: "ncii_notice"; requestRef: string; receivedAt: DateInput; deadlineAt: DateInput }
  | { code: "hash_match"; capturedAt: DateInput };

/**
 * A statement of reasons (ADR 0019 decision 7, DSA Art. 17(3)). Complete on its own: a suspended
 * user may not be able to sign in, so every element is in the mail, not behind the link. Ids,
 * enums and catalog keys come from the stored statement; `explanation` and `redress` are the
 * pinned `enforcement_notice` sections, rendered as text. NOT REVIEWED BY COUNSEL.
 */
export interface EnforcementStatementData {
  statementRef: string;
  appliedAt: DateInput;
  contentType: (typeof ENFORCEMENT_CONTENT_TYPES)[number];
  restrictionKind: (typeof ENFORCEMENT_RESTRICTION_KINDS)[number];
  restrictionDetail: (typeof ENFORCEMENT_RESTRICTION_DETAILS)[number];
  /** Null: indefinite, or (a warning) not applicable. */
  endsAt: DateInput | null;
  facts: EnforcementFactsData;
  source: (typeof ENFORCEMENT_SOURCES)[number];
  automatedDetection: boolean;
  automatedDecision: (typeof ENFORCEMENT_AUTOMATED_DECISIONS)[number];
  groundKind: (typeof ENFORCEMENT_GROUNDS)[number];
  /** The clause's `titleKey` in this catalog block (`clause.<id>`). */
  clauseTitleKey: string;
  /** `id@version`, quoted so the user can cite it. */
  clauseRef: string;
  legalBasis: string | null;
  explanation: string;
  redress: string;
  /** False when no internal appeal applies (a T0 NCII-list match). */
  appealable: boolean;
  noticeIsDraft: boolean;
  appealsUrl: string;
}

/** A catalog key looked up at render time (the clause, restriction and label keys). */
const keyed = (m: object, key: string): string | undefined => {
  const v = (m as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
};

export const enforcementStatement = defineTemplate("enforcementStatement", {
  links: ["appealsUrl"],
  subject: (ctx, d: EnforcementStatementData) =>
    ctx.text(ctx.messages.subject, {
      restriction:
        keyed(ctx.messages, `restriction.${d.restrictionKind}.${d.restrictionDetail}`) ?? ctx.messages.restrictionOther,
    }),
  body: (ctx, d: EnforcementStatementData) => {
    const m = ctx.messages;
    const label = (key: string) => keyed(m, key) ?? key;
    const restriction = keyed(m, `restriction.${d.restrictionKind}.${d.restrictionDetail}`) ?? m.restrictionOther;
    const clause = keyed(m, d.clauseTitleKey) ?? d.clauseRef;
    const ends =
      d.restrictionKind === "warning"
        ? m.endsNotApplicable
        : d.endsAt === null
          ? m.endsIndefinite
          : ctx.dateTime(d.endsAt);
    const f = d.facts;
    let facts: React.ReactNode;
    switch (f.code) {
      case "classifier":
        facts = ctx.t(f.tier === "t1" ? m.factsClassifierT1 : m.factsClassifierT2, {
          category: label(`category.${f.category}`),
          capturedAt: ctx.dateTime(f.capturedAt),
          threshold: ctx.percent(f.threshold),
        });
        break;
      case "moderator_review":
        facts = ctx.t(m.factsReview, { caseRef: f.caseRef, decision: label(`decision.${f.decision}`) });
        break;
      case "ncii_notice":
        facts = ctx.t(m.factsNcii, {
          receivedAt: ctx.dateTime(f.receivedAt),
          requestRef: f.requestRef,
          deadlineAt: ctx.dateTime(f.deadlineAt),
        });
        break;
      case "hash_match":
        facts = ctx.t(m.factsHash, { capturedAt: ctx.dateTime(f.capturedAt) });
        break;
    }
    const decision = { fully: m.decisionFully, partially: m.decisionPartially, not: m.decisionNot }[
      d.automatedDecision
    ];
    const ground =
      d.groundKind === "illegal"
        ? ctx.t(m.groundIllegal, {
            clause,
            ref: d.clauseRef,
            legalBasis: d.legalBasis ? label(`legalBasis.${d.legalBasis}`) : "",
          })
        : ctx.t(m.groundTerms, { clause, ref: d.clauseRef });
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        {d.noticeIsDraft ? <Notice>{ctx.t(m.draft)}</Notice> : null}
        <P>
          {ctx.t(m.body, {
            appliedAt: ctx.dateTime(d.appliedAt),
            content: label(`content.${d.contentType}`),
          })}
        </P>
        <Facts
          items={[
            [m.refLabel, d.statementRef],
            [m.restrictionLabel, restriction],
            [m.endsLabel, ends],
            [m.scopeLabel, ctx.t(m.scopeAll)],
            [m.factsLabel, facts],
            [m.sourceLabel, d.source === "notice_art16" ? m.sourceNotice : m.sourceOwn],
            [m.automationLabel, `${d.automatedDetection ? m.detectionYes : m.detectionNo} ${decision}`],
            [m.groundLabel, ground],
            // An operator's notice may lack a clause's section; the title above still names it.
            ...(d.explanation.trim() === "" ? [] : [[m.explanationLabel, d.explanation] as [string, string]]),
          ]}
        />
        <P>
          <strong>{ctx.t(m.redressHeading)}</strong>
        </P>
        <P>{d.appealable ? ctx.t(m.appeal) : ctx.t(m.noAppeal, { contact: ctx.contact("abuse") })}</P>
        {d.redress.trim() === "" ? null : <P>{d.redress}</P>}
        <P>{ctx.t(m.courts)}</P>
        <Action ctx={ctx} href={d.appealsUrl} label={m.action} />
      </>
    );
  },
});

export interface AppealDecidedData {
  appealRef: string;
  kind: (typeof APPEAL_KINDS)[number];
  outcome: Exclude<(typeof APPEAL_STATUSES)[number], "open">;
  decidedAt: DateInput;
  decisionUrl: string;
}

export const appealDecided = defineTemplate("appealDecided", {
  links: ["decisionUrl"],
  subject: (ctx, d: AppealDecidedData) => ctx.text(ctx.messages.subject, { appealRef: d.appealRef }),
  body: (ctx, d: AppealDecidedData) => {
    const m = ctx.messages;
    const kind = { integrity: m.kindIntegrity, moderation: m.kindModeration, dmca: m.kindDmca, account: m.kindAccount }[
      d.kind
    ];
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body, { appealRef: <strong>{d.appealRef}</strong> })}</P>
        <Facts
          items={[
            [m.kindLabel, kind],
            [m.outcomeLabel, d.outcome === "overturned" ? m.outcomeOverturned : m.outcomeUpheld],
            [m.decidedLabel, ctx.dateTime(d.decidedAt)],
          ]}
        />
        <Action ctx={ctx} href={d.decisionUrl} label={m.action} />
        <Muted>{ctx.t(m.final)}</Muted>
      </>
    );
  },
});
