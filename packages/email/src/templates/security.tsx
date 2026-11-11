// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Security notices: two-step sign-in changes, new-device sign-ins, email changes, leaked stream keys. */
import type { DateInput } from "../format.ts";
import { Action, defineTemplate, Facts, H1, Muted, Notice, P } from "../template.tsx";

export interface TwoFactorChangeData {
  changedAt: DateInput;
  securityUrl: string;
}

export const twoFactorEnabled = defineTemplate("twoFactorEnabled", {
  links: ["securityUrl"],
  subject: (ctx) => ctx.text(ctx.messages.subject),
  body: (ctx, d: TwoFactorChangeData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body, { date: ctx.dateTime(d.changedAt) })}</P>
        <P>{ctx.t(m.recovery)}</P>
        <Action ctx={ctx} href={d.securityUrl} label={m.action} />
        <Notice>{ctx.t(m.notYou, { contact: ctx.contact("security") })}</Notice>
      </>
    );
  },
});

export const twoFactorDisabled = defineTemplate("twoFactorDisabled", {
  links: ["securityUrl"],
  subject: (ctx) => ctx.text(ctx.messages.subject),
  body: (ctx, d: TwoFactorChangeData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body, { date: ctx.dateTime(d.changedAt) })}</P>
        <Action ctx={ctx} href={d.securityUrl} label={m.action} />
        <Notice>{ctx.t(m.notYou, { contact: ctx.contact("security") })}</Notice>
      </>
    );
  },
});

export interface NewSignInData {
  signedInAt: DateInput;
  /**
   * Minutes between the sign-in and the send, for the relative time beside the UTC one ("just now"
   * at 0). The mail goes out right after the sign-in, so it is almost always 0.
   */
  minutesAgo?: number;
  /**
   * Coarse summary of the device, e.g. "Firefox · Linux" (never the raw user agent or IP). Absent
   * when the browser could not be identified: the mail says so in the reader's language.
   */
  device?: string;
  /** Coarse location (country or region), if known. */
  approximateLocation?: string;
  sessionsUrl: string;
}

export const newSignIn = defineTemplate("newSignIn", {
  links: ["sessionsUrl"],
  subject: (ctx) => ctx.text(ctx.messages.subject),
  body: (ctx, d: NewSignInData) => {
    const m = ctx.messages;
    const minutes = Math.max(0, Math.floor(d.minutesAgo ?? 0));
    const relative = minutes === 0 ? ctx.text(m.justNow) : ctx.text(m.minutesAgo, { minutes });
    const facts: [string, string][] = [
      [m.whenLabel, ctx.text(m.when, { date: ctx.dateTime(d.signedInAt), relative })],
      [m.deviceLabel, d.device ?? ctx.text(m.deviceUnknown)],
    ];
    if (d.approximateLocation) facts.push([m.locationLabel, d.approximateLocation]);
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body)}</P>
        <Facts items={facts} />
        <P>{ctx.t(m.itWasYou)}</P>
        <Notice>{ctx.t(m.notYou)}</Notice>
        <Action ctx={ctx} href={d.sessionsUrl} label={m.action} />
      </>
    );
  },
});

export interface ChangeEmailConfirmData {
  /** The address asked for, as text: the owner of the current address should recognise it. */
  newEmail: string;
  confirmUrl: string;
  expiresInMinutes: number;
}

/**
 * To the CURRENT address when a member asks to change it (better-auth `sendChangeEmailConfirmation`).
 * Its link sends a verification mail to the new address; the email changes only after that one.
 */
export const changeEmailConfirm = defineTemplate("changeEmailConfirm", {
  links: ["confirmUrl"],
  subject: (ctx) => ctx.text(ctx.messages.subject),
  body: (ctx, d: ChangeEmailConfirmData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body, { newEmail: <strong>{d.newEmail}</strong> })}</P>
        <P>{ctx.t(m.next)}</P>
        <Action ctx={ctx} href={d.confirmUrl} label={m.action} />
        <Muted>{ctx.t(m.expiry, { minutes: d.expiresInMinutes })}</Muted>
        <Notice>{ctx.t(m.notYou, { contact: ctx.contact("security") })}</Notice>
      </>
    );
  },
});

export interface StreamKeyRevokedData {
  channelName: string;
  detectedAt: DateInput;
  /** Where the key was found, e.g. "a public code repository". */
  foundIn?: string;
  streamKeysUrl: string;
}

export const streamKeyRevoked = defineTemplate("streamKeyRevoked", {
  links: ["streamKeysUrl"],
  subject: (ctx, d: StreamKeyRevokedData) => ctx.text(ctx.messages.subject, { channel: d.channelName }),
  body: (ctx, d: StreamKeyRevokedData) => {
    const m = ctx.messages;
    const facts: [string, string][] = [[m.detectedLabel, ctx.dateTime(d.detectedAt)]];
    if (d.foundIn) facts.push([m.sourceLabel, d.foundIn]);
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body, { channel: <strong>{d.channelName}</strong> })}</P>
        <Facts items={facts} />
        <Notice>{ctx.t(m.next)}</Notice>
        <Action ctx={ctx} href={d.streamKeysUrl} label={m.action} />
        <Muted>{ctx.t(m.tip)}</Muted>
      </>
    );
  },
});
