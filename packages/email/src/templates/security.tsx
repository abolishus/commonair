// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Security notices: two-factor changes, new-device sign-ins, leaked stream keys. */
import type { DateInput } from "../format.ts";
import { Action, defineTemplate, Facts, H1, Muted, Notice, P } from "../template.tsx";

export interface TwoFactorChangeData {
  changedAt: DateInput;
  securityUrl: string;
}

export const twoFactorEnabled = defineTemplate("twoFactorEnabled", {
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
  /** Human summary of the device, e.g. "Firefox on Linux" (never the raw user agent or IP). */
  device: string;
  /** Coarse location (country or region), if known. */
  approximateLocation?: string;
  sessionsUrl: string;
}

export const newSignIn = defineTemplate("newSignIn", {
  subject: (ctx) => ctx.text(ctx.messages.subject),
  body: (ctx, d: NewSignInData) => {
    const m = ctx.messages;
    const facts: [string, string][] = [
      [m.whenLabel, ctx.dateTime(d.signedInAt)],
      [m.deviceLabel, d.device],
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

export interface StreamKeyRevokedData {
  channelName: string;
  detectedAt: DateInput;
  /** Where the key was found, e.g. "a public code repository". */
  foundIn?: string;
  streamKeysUrl: string;
}

export const streamKeyRevoked = defineTemplate("streamKeyRevoked", {
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
