// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Data rights: exports and account deletion. */
import type { DateInput } from "../format.ts";
import { Action, defineTemplate, H1, Muted, Notice, P } from "../template.tsx";

export interface DataExportReadyData {
  /** An instance page that checks the session and redirects to the signed download. */
  downloadUrl: string;
  expiresAt: DateInput;
}

export const dataExportReady = defineTemplate("dataExportReady", {
  subject: (ctx) => ctx.text(ctx.messages.subject),
  body: (ctx, d: DataExportReadyData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body)}</P>
        <Action ctx={ctx} href={d.downloadUrl} label={m.action} />
        <Notice>{ctx.t(m.expiry, { date: ctx.dateTime(d.expiresAt) })}</Notice>
        <Muted>{ctx.t(m.signInNote)}</Muted>
      </>
    );
  },
});

export interface AccountDeletionScheduledData {
  deleteAt: DateInput;
  cancelUrl: string;
}

export const accountDeletionScheduled = defineTemplate("accountDeletionScheduled", {
  subject: (ctx, d: AccountDeletionScheduledData) => ctx.text(ctx.messages.subject, { date: ctx.date(d.deleteAt) }),
  body: (ctx, d: AccountDeletionScheduledData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body, { date: <strong>{ctx.date(d.deleteAt)}</strong> })}</P>
        <P>{ctx.t(m.cancelInfo)}</P>
        <Action ctx={ctx} href={d.cancelUrl} label={m.action} />
        <Notice>{ctx.t(m.notYou, { contact: ctx.contact("privacy") })}</Notice>
      </>
    );
  },
});

export interface AccountDeletionCompletedData {
  deletedAt: DateInput;
}

export const accountDeletionCompleted = defineTemplate("accountDeletionCompleted", {
  subject: (ctx) => ctx.text(ctx.messages.subject),
  body: (ctx, d: AccountDeletionCompletedData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body, { date: ctx.date(d.deletedAt) })}</P>
        <P>{ctx.t(m.retained)}</P>
        <Muted>{ctx.t(m.farewell)}</Muted>
      </>
    );
  },
});
