// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sign-up and sign-in mail: email verification, magic link, password reset. */
import { Action, defineTemplate, H1, Muted, P } from "../template.tsx";

export interface VerifyEmailData {
  displayName: string;
  verifyUrl: string;
  expiresInMinutes: number;
}

export const verifyEmail = defineTemplate("verifyEmail", {
  subject: (ctx) => ctx.text(ctx.messages.subject),
  body: (ctx, d: VerifyEmailData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.greeting, { displayName: d.displayName })}</P>
        <P>{ctx.t(m.body)}</P>
        <Action ctx={ctx} href={d.verifyUrl} label={m.action} />
        <Muted>{ctx.t(m.expiry, { minutes: d.expiresInMinutes })}</Muted>
        <Muted>{ctx.t(m.ignore)}</Muted>
      </>
    );
  },
});

export interface MagicLinkData {
  signInUrl: string;
  expiresInMinutes: number;
}

export const magicLink = defineTemplate("magicLink", {
  subject: (ctx) => ctx.text(ctx.messages.subject),
  body: (ctx, d: MagicLinkData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body)}</P>
        <Action ctx={ctx} href={d.signInUrl} label={m.action} />
        <Muted>{ctx.t(m.expiry, { minutes: d.expiresInMinutes })}</Muted>
        <Muted>{ctx.t(m.ignore)}</Muted>
      </>
    );
  },
});

export interface PasswordResetData {
  resetUrl: string;
  expiresInMinutes: number;
}

export const passwordReset = defineTemplate("passwordReset", {
  subject: (ctx) => ctx.text(ctx.messages.subject),
  body: (ctx, d: PasswordResetData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body)}</P>
        <Action ctx={ctx} href={d.resetUrl} label={m.action} />
        <Muted>{ctx.t(m.expiry, { minutes: d.expiresInMinutes })}</Muted>
        <Muted>{ctx.t(m.ignore)}</Muted>
      </>
    );
  },
});
