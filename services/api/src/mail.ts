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

/**
 * Caps mail per recipient address across all senders and IPs, so nobody can flood a stranger's
 * inbox with reset, magic-link or verification mail by rotating addresses. Over the cap the
 * message is dropped (logged without the address) and the caller sees a normal success, which
 * also keeps the endpoints from revealing whether an account exists.
 */
export function recipientLimitedMailer(inner: Mailer, limit: RecipientLimit): Mailer {
  return {
    async send(template, props, to) {
      const subject = await hmacHex(limit.secret, `mail:${to.trim().toLowerCase()}`);
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
