// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Transactional mail. Handlers depend on the `Mailer` interface only; the SMTP
 * implementation is the default (Mailpit locally). A later unit swaps the plain
 * templates below for React Email templates from @commonair/email.
 */
import nodemailer from "nodemailer";
import type { InstanceSite } from "@commonair/config/site";
import type { Logger } from "@commonair/observability";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
  close(): Promise<void>;
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string | undefined;
  password?: string | undefined;
  from: string;
}

export function createSmtpMailer(opts: SmtpOptions, logger: Logger): Mailer {
  const transport = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    auth: opts.user ? { user: opts.user, pass: opts.password ?? "" } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send(m) {
      try {
        await transport.sendMail({ from: opts.from, to: m.to, subject: m.subject, text: m.text, html: m.html });
      } catch (err) {
        // Never log the address; the subject identifies the template.
        logger.error("mail send failed", { subject: m.subject, err });
        throw err;
      }
    },
    async close() {
      transport.close();
    },
  };
}

/** Default From: MAIL_FROM, else "<instance name> <noreply contact>". */
export function defaultFrom(site: InstanceSite, mailFrom?: string): string {
  if (mailFrom) return mailFrom;
  const name = site.name.replace(/["<>\r\n]/g, "");
  return `"${name}" <${site.contacts.noreply}>`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function linkMail(to: string, subject: string, intro: string, url: string, outro: string): MailMessage {
  return {
    to,
    subject,
    text: `${intro}\n\n${url}\n\n${outro}\n`,
    html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p><p>${escapeHtml(outro)}</p>`,
  };
}

/** Plain templates. Wording is server-side email copy, not UI strings. */
export const templates = {
  verifyEmail: (site: InstanceSite, to: string, url: string) =>
    linkMail(
      to,
      `Verify your email for ${site.name}`,
      `Welcome to ${site.name}. Confirm your email address to finish creating your account:`,
      url,
      "If you did not sign up, you can ignore this message.",
    ),
  magicLink: (site: InstanceSite, to: string, url: string) =>
    linkMail(
      to,
      `Your ${site.name} sign-in link`,
      "Use this link to sign in. It expires in a few minutes and works once:",
      url,
      "If you did not ask to sign in, you can ignore this message.",
    ),
  resetPassword: (site: InstanceSite, to: string, url: string) =>
    linkMail(
      to,
      `Reset your ${site.name} password`,
      "Someone asked to reset the password for your account. Use this link to choose a new one:",
      url,
      "If this was not you, ignore this message; your password stays the same.",
    ),
  twoFactorEnabled: (site: InstanceSite, to: string) => ({
    to,
    subject: `Two-factor authentication enabled on ${site.name}`,
    text: `Two-factor authentication was just turned on for your account. If this was not you, reset your password and contact ${site.contacts.security}.\n`,
    html: `<p>Two-factor authentication was just turned on for your account. If this was not you, reset your password and contact ${escapeHtml(site.contacts.security)}.</p>`,
  }),
  streamKeyLeaked: (site: InstanceSite, to: string) => ({
    to,
    subject: `Your ${site.name} stream key was revoked`,
    text: "Your stream key appeared in public text (chat or your channel page), so we revoked it to protect your channel. Create a new key in your dashboard and update your encoder.\n",
    html: "<p>Your stream key appeared in public text (chat or your channel page), so we revoked it to protect your channel. Create a new key in your dashboard and update your encoder.</p>",
  }),
};
