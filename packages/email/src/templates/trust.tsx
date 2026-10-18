// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Trust & safety: copyright notices, restorations, appeal decisions. */
import type { APPEAL_KINDS, APPEAL_STATUSES } from "@commonair/contracts/enums";
import type { DateInput } from "../format.ts";
import { Action, defineTemplate, Facts, H1, Muted, P } from "../template.tsx";

export interface DmcaNoticeReceivedData {
  contentTitle: string;
  noticeRef: string;
  receivedAt: DateInput;
  noticeUrl: string;
}

export const dmcaNoticeReceived = defineTemplate("dmcaNoticeReceived", {
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

export interface ContentRestoredData {
  contentTitle: string;
  restoredAt: DateInput;
  contentUrl: string;
}

export const contentRestored = defineTemplate("contentRestored", {
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
