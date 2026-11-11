// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The "new sign-in" email (overhaul wave 5; d7-security left the template unsent). better-auth's
 * `session.create.after` hook calls `onSessionCreated`, which only sorts out the cheap cases and
 * hands the rest to the auth background (`background.ts`), so a sign-in never waits on, or fails
 * with, the lookup or the mail.
 *
 * Only a sign-in that just completed counts: a password, social, magic-link or passkey sign-in, or
 * the code step of a two-step sign-in. Sessions created for an already signed-in browser (a
 * change of password, two-step set-up, passkey re-auth, an email change), the sign-up's first
 * session (`/verify-email`), impersonation, bots and demo accounts never mail. A two-step member's
 * password step does not count (that session is deleted at once, and the code step mails); nor
 * does a password sign-in on a device they marked as trusted, which is one they have used before.
 * At most one per member per 10 minutes, claimed with a Valkey key. Never the IP (none is kept).
 */
import { SECURITY_SETTINGS_PATH } from "@commonair/contracts/auth";
import { anchoredUser, schema, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import type { InstanceSite } from "@commonair/config/site";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import { appUrl, type Mailer } from "../mail.ts";
import type { AuthBackground } from "./background.ts";

/** Password sign-ins: a two-step member's is only the first step. */
export const PASSWORD_SIGN_IN_PATHS: ReadonlySet<string> = new Set(["/sign-in/email", "/sign-in/username"]);
/** Every other endpoint whose session is a completed sign-in. */
export const COMPLETED_SIGN_IN_PATHS: ReadonlySet<string> = new Set([
  "/sign-in/social",
  "/callback/:id",
  "/magic-link/verify",
  "/passkey/verify-authentication",
  "/two-factor/verify-totp",
  "/two-factor/verify-otp",
  "/two-factor/verify-backup-code",
]);

/** One email per member per this long, whatever the number of sign-ins. */
export const NEW_SIGN_IN_WINDOW_SECONDS = 600;
export const newSignInKey = (userId: string) => `auth:new-sign-in:${userId}`;

/** Whether a session made on `path` is a completed sign-in for a member with or without two-step. */
export function isCompletedSignIn(path: string | undefined, twoFactorEnabled: boolean): boolean {
  if (path === undefined) return false;
  if (PASSWORD_SIGN_IN_PATHS.has(path)) return !twoFactorEnabled;
  return COMPLETED_SIGN_IN_PATHS.has(path);
}

/** Whether the endpoint could be a sign-in at all (checked before anything is read). */
export const mayBeSignIn = (path: string | undefined): boolean =>
  path !== undefined && (PASSWORD_SIGN_IN_PATHS.has(path) || COMPLETED_SIGN_IN_PATHS.has(path));

/** First match wins: Edge and Opera also say Chrome, Chrome also says Safari. */
const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\/|\bChromium\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];
const SYSTEMS: readonly [RegExp, string][] = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

/**
 * The device in coarse words, as the security page shows it ("Firefox · Linux"): brand names only,
 * never a version, a model or the raw user agent. Undefined when neither is recognised (the mail
 * says so in the reader's language).
 */
export function coarseDevice(userAgent: string | null | undefined): string | undefined {
  const ua = (userAgent ?? "").slice(0, 512);
  const first = (table: readonly [RegExp, string][]) => table.find(([re]) => re.test(ua))?.[1];
  const browser = first(BROWSERS);
  const os = first(SYSTEMS);
  if (browser && os) return `${browser} · ${os}`;
  return browser ?? os;
}

/** What the hook needs from better-auth's endpoint context. */
export interface SignInRequest {
  path: string | undefined;
  /** The endpoint already resolved a session for this request (it was signed in). */
  hasSession: boolean;
  /** The request's own session cookie (the token), if it carried a valid signature. */
  sessionCookie: () => Promise<string | null>;
}

export interface CreatedSession {
  id: string;
  userId: string;
  createdAt: Date;
  userAgent?: string | null;
  impersonatedBy?: string | null;
}

export interface NewSignInDeps {
  db: Database;
  valkey: Pick<ValkeyClient, "set" | "del">;
  mailer: Mailer;
  site: InstanceSite;
  logger: Logger;
  now: () => Date;
}

/** better-auth's `session.create.after`: never throws, never waits on more than a few set lookups. */
export function onSessionCreated(
  deps: NewSignInDeps,
  background: AuthBackground,
  session: CreatedSession,
  req: SignInRequest | null,
): void {
  if (!req || req.hasSession || session.impersonatedBy || !mayBeSignIn(req.path)) return;
  background.handler(sendIfNewSignIn(deps, session, req));
}

export type NewSignInOutcome =
  | "sent"
  | "not_sign_in"
  | "already_signed_in"
  | "not_mailable"
  | "rate_limited"
  | "failed";

/** The background half. Exported for tests; logs ids and the outcome only. */
export async function sendIfNewSignIn(
  deps: NewSignInDeps,
  session: CreatedSession,
  req: SignInRequest,
): Promise<NewSignInOutcome> {
  const { db } = deps;
  const u = schema.users;
  const [user] = await db
    .select({
      email: u.email,
      emailVerified: u.emailVerified,
      locale: u.locale,
      accountType: u.accountType,
      twoFactorEnabled: u.twoFactorEnabled,
      deletedAt: u.deletedAt,
      pseudonymizedAt: u.pseudonymizedAt,
      demo: sql<boolean>`${anchoredUser()}`,
    })
    .from(u)
    .where(eq(u.id, session.userId));
  if (!user || !isCompletedSignIn(req.path, user.twoFactorEnabled === true)) return "not_sign_in";
  if (!user.emailVerified || user.accountType !== "human" || user.deletedAt || user.pseudonymizedAt || user.demo)
    return "not_mailable";
  // A browser still holding one of the member's live sessions was already signed in.
  const token = await req.sessionCookie();
  if (token) {
    const s = schema.sessions;
    const [live] = await db
      .select({ id: s.id })
      .from(s)
      .where(and(eq(s.token, token), eq(s.userId, session.userId), ne(s.id, session.id), gt(s.expiresAt, deps.now())))
      .limit(1);
    if (live) return "already_signed_in";
  }
  const key = newSignInKey(session.userId);
  const claimed = await deps.valkey.set(key, "1", "EX", NEW_SIGN_IN_WINDOW_SECONDS, "NX");
  if (claimed !== "OK") return "rate_limited";
  const createdAt = new Date(session.createdAt);
  try {
    await deps.mailer.send(
      "newSignIn",
      {
        signedInAt: createdAt,
        minutesAgo: Math.max(0, Math.floor((deps.now().getTime() - createdAt.getTime()) / 60_000)),
        device: coarseDevice(session.userAgent),
        sessionsUrl: appUrl(deps.site, `${SECURITY_SETTINGS_PATH}#sessions`),
        locale: user.locale ?? undefined,
      },
      user.email,
    );
  } catch (err) {
    // The next sign-in may try again; never the address.
    await deps.valkey.del(key).catch(() => undefined);
    deps.logger.warn("new sign-in mail failed", {
      userId: session.userId,
      err: err instanceof Error ? err.name : "unknown",
    });
    return "failed";
  }
  return "sent";
}
