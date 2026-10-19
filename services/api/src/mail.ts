// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Transactional mail for the API, on @commonair/email (React Email templates,
 * SMTP via nodemailer). Handlers depend on the `Mailer` interface only; tests may
 * pass a `MemoryMailer`.
 *
 * Templates accept only links on PUBLIC_URL's origin. better-auth builds its links on
 * API_PUBLIC_URL, so `publicLink` moves them onto PUBLIC_URL with the same path: the
 * public origin must route `/api/*` to this service (the reverse proxy does).
 */
import type { InstanceSite } from "@commonair/config/site";
import { createMailer, type Mailer } from "@commonair/email";
import type { Logger } from "@commonair/observability";
import { hmacHex } from "@commonair/tokens";
import type { ApiEnv } from "./env.ts";
import { rateLimitKey, type RateLimitRule, type RateLimitStore } from "./lib/ratelimit.ts";

export type { Mailer } from "@commonair/email";

export function createApiMailer(env: ApiEnv, site: InstanceSite): Mailer {
  return createMailer(env, { site });
}

/** Re-home an absolute link (e.g. on API_PUBLIC_URL) onto the instance's public origin. */
export function publicLink(site: InstanceSite, link: string): string {
  const src = new URL(link);
  const out = new URL(site.publicUrl);
  out.pathname = src.pathname;
  out.search = src.search;
  out.hash = "";
  return out.toString();
}

/** A page of the web app on the public origin. */
export const appUrl = (site: InstanceSite, path: string) => new URL(path, `${site.publicUrl}/`).toString();

/** Sending mail must never fail the action that triggered it when the mail is only a notice. */
export async function sendNotice(logger: Logger, what: string, send: () => Promise<unknown>): Promise<void> {
  try {
    await send();
  } catch (err) {
    // Never log the address; the template id identifies the message.
    logger.warn("mail send failed", { template: what, err });
  }
}

export interface RecipientLimit {
  secret: string;
  store: () => RateLimitStore;
  rule: () => RateLimitRule;
  now: () => Date;
  logger: Logger;
}

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * The mailbox an address delivers to, for rate limiting: lowercase, `+tag` dropped (every domain:
 * a few providers do not honour tags, which only makes the cap stricter for them), and for Gmail
 * dots dropped and googlemail.com folded into gmail.com.
 */
export function mailboxOf(address: string): string {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at <= 0) return a;
  let local = a.slice(0, at);
  let domain = a.slice(at + 1).replace(/\.$/, "");
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

/**
 * Caps mail per recipient mailbox and template across all senders and IPs, so nobody can flood a
 * stranger's inbox with reset, magic-link or verification mail by rotating addresses or tag/dot
 * spellings. The cap is per template, so a flood of one kind cannot block a password reset or a
 * verification mail. Over the cap the message is dropped (logged without the address) and the
 * caller sees a normal success, which also keeps the endpoints from revealing whether an account
 * exists.
 */
export function recipientLimitedMailer(inner: Mailer, limit: RecipientLimit): Mailer {
  return {
    async send(template, props, to) {
      const subject = `${template}:${await hmacHex(limit.secret, `mail:${mailboxOf(to)}`)}`;
      const r = await limit
        .store()
        .hit(rateLimitKey("mail", subject), limit.rule(), limit.now().getTime(), crypto.randomUUID());
      if (!r.allowed) {
        limit.logger.warn("mail dropped: recipient rate limit", { template });
        return "";
      }
      return inner.send(template, props, to);
    },
    close: () => inner.close(),
  };
}
