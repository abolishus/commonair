// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Sending mail: `createMailer` (SMTP via nodemailer) for services and
 * `MemoryMailer` for tests. Both render the same way, so tests see exactly
 * what would go on the wire.
 */
import type { InstanceSite, mailEnv } from "@commonair/config";
import nodemailer from "nodemailer";
import type { z } from "zod";
import type { Catalogs } from "./messages/index.ts";
import type { TemplateData } from "./registry.ts";
import { normalizeInstanceUrl, renderEmail } from "./render.tsx";
import type { TemplateId } from "./template.tsx";

export type MailEnv = z.output<typeof mailEnv>;

/** Template data plus the recipient's preferred locale. */
export type SendProps<K extends TemplateId> = TemplateData<K> & { locale?: string | undefined };

export interface Mailer {
  /** Render `template` and send it to one recipient; resolves to the message id. */
  send<K extends TemplateId>(template: K, props: SendProps<K>, to: string): Promise<string>;
  close(): Promise<void>;
}

export interface MailerOptions {
  site: InstanceSite;
  catalogs?: Catalogs;
}

export interface OutgoingMail {
  template: TemplateId;
  locale: string;
  from: { name: string; address: string } | string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

export class InvalidRecipientError extends Error {
  constructor() {
    super("recipient must be a single email address");
    this.name = "InvalidRecipientError";
  }
}

// One bare address, no display name, no lists, no header-breaking characters.
const SINGLE_ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+$/;

/**
 * `MAIL_FROM` wins. Otherwise the instance's noreply contact (`NOREPLY_EMAIL`, defaulting in
 * `instanceSite()` to the flagship's on the flagship and to noreply@<public host> elsewhere), so
 * mail never claims to come from a domain the instance does not control.
 */
export function defaultFrom(site: InstanceSite, mailFrom?: string): OutgoingMail["from"] {
  if (mailFrom) return mailFrom;
  return { name: site.name, address: site.contacts.noreply };
}

export async function buildMail<K extends TemplateId>(
  template: K,
  props: SendProps<K>,
  to: string,
  opts: MailerOptions & { from: OutgoingMail["from"] },
): Promise<OutgoingMail> {
  if (!SINGLE_ADDRESS.test(to)) throw new InvalidRecipientError();
  const { locale, ...data } = props;
  const rendered = await renderEmail(template, data as unknown as TemplateData<K>, {
    site: opts.site,
    locale,
    ...(opts.catalogs ? { catalogs: opts.catalogs } : {}),
  });
  const headers: Record<string, string> = {
    // RFC 3834: suppress vacation auto-replies to automated mail.
    "Auto-Submitted": "auto-generated",
  };
  if (rendered.unsubscribeUrl) {
    // Normalised `href` only (already validated at render; re-checked here because it goes into a
    // header): WHATWG serialisation percent-encodes `<`, `>`, spaces and controls, so the value
    // cannot close the angle brackets and splice in a second URL.
    const href = normalizeInstanceUrl(rendered.unsubscribeUrl, opts.site, "unsubscribeUrl");
    headers["List-Unsubscribe"] = `<${href}>`;
    // RFC 8058 one-click: the URL must accept a POST without further interaction.
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  return {
    template,
    locale: rendered.locale,
    from: opts.from,
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers,
  };
}

export interface SmtpMailerOptions extends MailerOptions {
  /** Socket-level timeouts in ms (connect, greeting, idle). */
  timeouts?: { connection?: number; greeting?: number; socket?: number };
  /** Connections kept open for bursts (default 3). */
  maxConnections?: number;
}

export class MailerClosedError extends Error {
  constructor() {
    super("mailer is closed");
    this.name = "MailerClosedError";
  }
}

/**
 * nodemailer transport options from `mailEnv`. STARTTLS is required when `SMTP_REQUIRE_TLS`
 * is set, and always when credentials would otherwise be sent over a plain connection.
 */
export function smtpTransportOptions(env: MailEnv, opts: Omit<SmtpMailerOptions, keyof MailerOptions> = {}) {
  const auth = env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? "" } : undefined;
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    requireTLS: !env.SMTP_SECURE && (env.SMTP_REQUIRE_TLS || auth !== undefined),
    ...(auth ? { auth } : {}),
    pool: true as const,
    maxConnections: opts.maxConnections ?? 3,
    connectionTimeout: opts.timeouts?.connection ?? 10_000,
    greetingTimeout: opts.timeouts?.greeting ?? 10_000,
    socketTimeout: opts.timeouts?.socket ?? 30_000,
  };
}

/** SMTP mailer from `mailEnv`. Pooled; `close()` waits for in-flight sends, then closes the pool. */
export function createMailer(env: MailEnv, opts: SmtpMailerOptions): Mailer {
  const transport = nodemailer.createTransport(smtpTransportOptions(env, opts));
  const from = defaultFrom(opts.site, env.MAIL_FROM);
  const inFlight = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;

  const deliver = async <K extends TemplateId>(template: K, props: SendProps<K>, to: string) => {
    const mail = await buildMail(template, props, to, { ...opts, from });
    const info = await transport.sendMail({
      from: mail.from,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      headers: mail.headers,
    });
    return info.messageId;
  };

  return {
    send(template, props, to) {
      if (closing) return Promise.reject(new MailerClosedError());
      const pending = deliver(template, props, to);
      inFlight.add(pending);
      const forget = () => inFlight.delete(pending);
      pending.then(forget, forget);
      return pending;
    },
    close() {
      closing ??= Promise.allSettled(inFlight).then(() => transport.close());
      return closing;
    },
  };
}

/** Captures mail instead of sending it. */
export class MemoryMailer implements Mailer {
  readonly sent: (OutgoingMail & { messageId: string })[] = [];
  private readonly from: OutgoingMail["from"];

  constructor(private readonly opts: MailerOptions & { mailFrom?: string }) {
    this.from = defaultFrom(opts.site, opts.mailFrom);
  }

  async send<K extends TemplateId>(template: K, props: SendProps<K>, to: string): Promise<string> {
    const mail = await buildMail(template, props, to, { ...this.opts, from: this.from });
    const messageId = `<${crypto.randomUUID()}@${new URL(this.opts.site.publicUrl).hostname}>`;
    this.sent.push({ ...mail, messageId });
    return messageId;
  }

  /** Mail sent to `to`, oldest first. */
  to(address: string): (OutgoingMail & { messageId: string })[] {
    return this.sent.filter((m) => m.to === address);
  }

  clear(): void {
    this.sent.length = 0;
  }

  async close(): Promise<void> {}
}
