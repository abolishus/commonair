// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Trust & safety: copyright notices, restorations, appeal decisions. The DMCA mails follow
 * 17 U.S.C. § 512 as the platform reads it; NOT REVIEWED BY A LAWYER (docs/operators/dmca.md).
 */
import type { APPEAL_KINDS, APPEAL_STATUSES } from "@commonair/contracts/enums";
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
        <P>{ctx.t(actioned ? m.bodyActioned : m.bodyRejected, { noticeRef: <strong>{d.noticeRef}</strong> })}</P>
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
