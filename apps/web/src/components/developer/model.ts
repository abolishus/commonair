// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Developer console logic, pure for unit tests: the app, subscription, bot and token forms
 * (bounds from the contract), the error-code mapping and the labels of enum values.
 */
import { APP_SUSPENSION_REASONS, SUBSCRIPTION_STATES } from "@commonair/contracts/enums";
import { OAUTH_LIMITS, redirectUriProblem } from "@commonair/contracts/oauth";
import { SCOPE_NAMES, type Scope } from "@commonair/contracts/scopes";
import { t, type MessageKey } from "../../i18n/index.ts";
import { errorCode } from "../../lib/api.ts";
import { errorRequirement } from "../../lib/coop.ts";
import { type Checked, type FieldErrors, parseBoundedInt } from "../../lib/interact-studio.ts";
import type {
  AccessTokenDto,
  AppCreateInput,
  BotCreateInput,
  BotTokenInput,
  CatalogEntry,
  DeliveryDto,
  SubscribeInput,
  SubscriptionDto,
  SuspensionReason,
} from "./client.ts";

export type { Checked, FieldErrors };

export const APP_LIMITS = {
  nameMax: 50,
  descriptionMax: 500,
  redirectUriMax: 2000,
  redirectUrisMax: OAUTH_LIMITS.redirectUrisPerApp,
} as const;

// ── Errors ───────────────────────────────────────────────────────────────────────────────────

/** `PRECONDITION_FAILED` requirements the console explains (wave-2 handlers and `me.bots`). */
const REQUIREMENT_KEYS: Record<string, MessageKey> = {
  app_limit: "developer.error.appLimit",
  app_suspended: "developer.error.appSuspended",
  public_client: "developer.error.publicClient",
  subscription_limit: "developer.error.subscriptionLimit",
  websocket_only: "developer.error.websocketOnly",
  condition_keys: "developer.error.conditionKeys",
  callback_url: "developer.error.callbackUrl",
  version: "developer.error.version",
  token_required: "developer.error.tokenRequired",
  webhook_only: "developer.error.webhookOnly",
  not_enabled: "developer.error.notEnabled",
  notification_only: "developer.error.notificationOnly",
  not_replayable: "developer.error.notReplayable",
  bot_limit: "developer.error.botLimit",
  channel_bot: "developer.error.channelBot",
};

export type ErrorOverrides = Partial<Record<"CONFLICT" | "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST", MessageKey>>;

/**
 * The message for a failed console call: a known requirement first, then the code (callers
 * override what a code means for their action), else `fallback`.
 */
export function developerError(err: unknown, fallback: MessageKey, overrides: ErrorOverrides = {}): string {
  const code = errorCode(err);
  if (code === "PRECONDITION_FAILED") {
    const key = REQUIREMENT_KEYS[errorRequirement(err) ?? ""];
    if (key) return t(key, { appsMax: OAUTH_LIMITS.appsPerUser });
  }
  switch (code) {
    case "UNAUTHORIZED":
      return t("developer.error.session");
    case "RATE_LIMITED":
    case "TOO_MANY_REQUESTS":
      return t("developer.error.rateLimited");
    case "CONFLICT":
    case "FORBIDDEN":
    case "NOT_FOUND":
    case "BAD_REQUEST": {
      const key = overrides[code];
      if (key) return t(key);
      if (code === "NOT_FOUND") return t("developer.error.notFound");
      if (code === "BAD_REQUEST") return t("developer.error.invalid");
      if (code === "FORBIDDEN") return t("developer.error.forbidden");
      return t(fallback);
    }
    default:
      return t(fallback);
  }
}

// ── Apps ─────────────────────────────────────────────────────────────────────────────────────

/** `redirectUriProblem`'s English reasons → catalog keys (unknown reasons get the generic one). */
const REDIRECT_PROBLEM_KEYS: Record<string, MessageKey> = {
  "not an absolute URI": "developer.app.redirect.notAbsolute",
  "a fragment is not allowed": "developer.app.redirect.fragment",
  "userinfo is not allowed": "developer.app.redirect.userinfo",
  "https needs a host": "developer.app.redirect.noHost",
  "http is allowed on a loopback host only": "developer.app.redirect.httpLoopback",
  "a private-use scheme must contain a dot (reverse domain name)": "developer.app.redirect.privateScheme",
};

export interface RedirectLines {
  uris: string[];
  /** The first problem, already translated, naming the URI. */
  problem: string | null;
}

/** One URI per line: blank lines dropped, duplicates kept once, each checked like the API does. */
export function parseRedirectLines(text: string): RedirectLines {
  const uris = [...new Set(text.split(/\r?\n/).map((l) => l.trim()))].filter((l) => l !== "");
  if (uris.length === 0) return { uris, problem: t("developer.app.redirect.none") };
  if (uris.length > APP_LIMITS.redirectUrisMax)
    return { uris, problem: t("developer.app.redirect.tooMany", { max: APP_LIMITS.redirectUrisMax }) };
  for (const uri of uris) {
    if (uri.length > APP_LIMITS.redirectUriMax)
      return {
        uris,
        problem: t("developer.app.redirect.tooLong", { uri: uri.slice(0, 60), max: APP_LIMITS.redirectUriMax }),
      };
    const problem = redirectUriProblem(uri);
    if (problem !== null)
      return {
        uris,
        problem: t("developer.app.redirect.problem", {
          uri,
          problem: t(REDIRECT_PROBLEM_KEYS[problem] ?? "developer.app.redirect.invalid"),
        }),
      };
  }
  return { uris, problem: null };
}

export interface AppDraft {
  name: string;
  description: string;
  /** Redirect URIs, one per line. */
  redirects: string;
  confidential: boolean;
}

export type AppField = "name" | "description" | "redirects";

export const emptyAppDraft = (): AppDraft => ({ name: "", description: "", redirects: "", confidential: true });

export const appDraft = (app: {
  name: string;
  description: string;
  redirectUris: string[];
  confidential: boolean;
}): AppDraft => ({
  name: app.name,
  description: app.description,
  redirects: app.redirectUris.join("\n"),
  confidential: app.confidential,
});

/** The create input (update sends the same fields but `confidential`, which never changes). */
export function appInput(d: AppDraft): Checked<Required<AppCreateInput>, AppField> {
  const errors: FieldErrors<AppField> = {};
  const name = d.name.trim();
  if (name.length < 1 || name.length > APP_LIMITS.nameMax)
    errors.name = t("developer.app.error.name", { max: APP_LIMITS.nameMax });
  const description = d.description.trim();
  if (description.length > APP_LIMITS.descriptionMax)
    errors.description = t("developer.app.error.description", { max: APP_LIMITS.descriptionMax });
  const redirects = parseRedirectLines(d.redirects);
  if (redirects.problem !== null) errors.redirects = redirects.problem;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, input: { name, description, redirectUris: redirects.uris, confidential: d.confidential } };
}

export const SUSPENSION_REASON_KEYS: Record<SuspensionReason, MessageKey> = {
  abuse: "developer.reason.abuse",
  spam: "developer.reason.spam",
  security: "developer.reason.security",
  terms_violation: "developer.reason.terms_violation",
  impersonation: "developer.reason.impersonation",
  other: "developer.reason.other",
};

export const SUSPENSION_REASONS: readonly SuspensionReason[] = APP_SUSPENSION_REASONS;

// ── Subscriptions ────────────────────────────────────────────────────────────────────────────

/** Types a webhook can carry (WebSocket-only types such as `channel.chat.message` are left out). */
export const webhookTypes = (catalog: readonly CatalogEntry[]): CatalogEntry[] =>
  catalog.filter((e) => e.transports.includes("webhook")).sort((a, b) => a.type.localeCompare(b.type));

export interface SubscriptionDraft {
  type: string;
  condition: Record<string, string>;
  callback: string;
  secret: string;
}

export type SubscriptionField = "type" | "callback" | "secret" | `condition.${string}`;

export const WEBHOOK_SECRET = { min: 10, max: 100 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const emptySubscriptionDraft = (): SubscriptionDraft => ({ type: "", condition: {}, callback: "", secret: "" });

/** A webhook secret: 32 random bytes, base64url (43 characters). */
export function generateWebhookSecret(
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b),
): string {
  const bytes = random(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `events.subscribe` input for a webhook on behalf of `appId`. */
export function subscriptionInput(
  appId: string,
  d: SubscriptionDraft,
  catalog: readonly CatalogEntry[],
): Checked<SubscribeInput, SubscriptionField> {
  const errors: FieldErrors<SubscriptionField> = {};
  const def = webhookTypes(catalog).find((e) => e.type === d.type);
  if (!def) return { ok: false, errors: { type: t("developer.sub.error.type") } };
  const condition: Record<string, string> = {};
  for (const field of def.condition) {
    const value = (d.condition[field] ?? "").trim();
    if (value === "") errors[`condition.${field}`] = t("developer.sub.error.conditionMissing");
    else if (field.endsWith("user_id") && !UUID.test(value))
      errors[`condition.${field}`] = t("developer.sub.error.userId");
    condition[field] = value;
  }
  const callback = d.callback.trim();
  let url: URL | null = null;
  try {
    url = new URL(callback);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:"))
    errors.callback = t("developer.sub.error.callback");
  if (d.secret.length < WEBHOOK_SECRET.min || d.secret.length > WEBHOOK_SECRET.max)
    errors.secret = t("developer.sub.error.secret", { min: WEBHOOK_SECRET.min, max: WEBHOOK_SECRET.max });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    input: {
      type: def.type,
      version: def.version,
      condition,
      transport: { method: "webhook", callback, secret: d.secret },
      appId,
    },
  };
}

export type SubscriptionStatus = SubscriptionDto["status"];

export const SUBSCRIPTION_STATUS_KEYS: Record<SubscriptionStatus, MessageKey> = {
  enabled: "developer.sub.status.enabled",
  verification_pending: "developer.sub.status.verification_pending",
  failed: "developer.sub.status.failed",
  revoked: "developer.sub.status.revoked",
};

export const subscriptionTone = (s: SubscriptionStatus): "success" | "warning" | "danger" | "neutral" =>
  s === "enabled" ? "success" : s === "verification_pending" ? "warning" : s === "failed" ? "danger" : "neutral";

export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = SUBSCRIPTION_STATES;

/** A test event goes to an enabled webhook subscription only (`webhook_only`, `not_enabled`). */
export const canSendTest = (s: Pick<SubscriptionDto, "transport" | "status">): boolean =>
  s.transport.method === "webhook" && s.status === "enabled";

/**
 * Redelivery is offered on notifications (never on the challenge or a revocation). The API also
 * replays a succeeded one, for a receiver that acknowledged and then lost it; test events cannot
 * be replayed and come back with `not_replayable`.
 */
export const canRedeliver = (d: Pick<DeliveryDto, "messageType">): boolean => d.messageType === "notification";

export const DELIVERY_STATUS_KEYS: Record<DeliveryDto["status"], MessageKey> = {
  pending: "developer.delivery.status.pending",
  succeeded: "developer.delivery.status.succeeded",
  failed: "developer.delivery.status.failed",
};

export const deliveryTone = (s: DeliveryDto["status"]): "success" | "danger" | "neutral" =>
  s === "succeeded" ? "success" : s === "failed" ? "danger" : "neutral";

/**
 * Merge a fresh first page into the rows on screen: the fresh rows replace their old copies (a
 * pending delivery that finished), older rows already paged in stay below.
 */
export function mergeFirstPage<T extends { id: string }>(fresh: readonly T[], shown: readonly T[]): T[] {
  const ids = new Set(fresh.map((r) => r.id));
  // Rows that fell off the first page (newer ones pushed them down) stay on screen, in order.
  return [...fresh, ...shown.filter((r) => !ids.has(r.id))];
}

// ── Bots and tokens ──────────────────────────────────────────────────────────────────────────

export const BOT_LIMITS = {
  usernameMin: 3,
  usernameMax: 25,
  displayNameMax: 40,
  daysMin: 1,
  daysMax: 365,
  daysDefault: 90,
} as const;

export interface BotDraft {
  username: string;
  displayName: string;
}
export type BotField = "username" | "displayName";

export function botInput(d: BotDraft): Checked<BotCreateInput, BotField> {
  const errors: FieldErrors<BotField> = {};
  const username = d.username.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,25}$/.test(username))
    errors.username = t("developer.bot.error.username", { min: BOT_LIMITS.usernameMin, max: BOT_LIMITS.usernameMax });
  const displayName = d.displayName.trim();
  if (displayName.length < 1 || displayName.length > BOT_LIMITS.displayNameMax)
    errors.displayName = t("developer.bot.error.displayName", { max: BOT_LIMITS.displayNameMax });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, input: { username, displayName } };
}

export interface TokenDraft {
  scopes: Scope[];
  days: string;
}
export type TokenField = "scopes" | "days";

export const emptyTokenDraft = (): TokenDraft => ({ scopes: [], days: String(BOT_LIMITS.daysDefault) });

export const ALL_SCOPES: readonly Scope[] = SCOPE_NAMES;

export function tokenInput(botId: string, d: TokenDraft): Checked<BotTokenInput, TokenField> {
  const errors: FieldErrors<TokenField> = {};
  const scopes = ALL_SCOPES.filter((s) => d.scopes.includes(s));
  if (scopes.length === 0) errors.scopes = t("developer.token.error.scopes");
  const days = parseBoundedInt(d.days, BOT_LIMITS.daysMin, BOT_LIMITS.daysMax);
  if (days === null)
    errors.days = t("developer.token.error.days", { min: BOT_LIMITS.daysMin, max: BOT_LIMITS.daysMax });
  if (Object.keys(errors).length > 0 || days === null) return { ok: false, errors };
  return { ok: true, input: { botId, scopes, expiresInDays: days } };
}

export const toggleScope = (scopes: readonly Scope[], scope: Scope, on: boolean): Scope[] =>
  on ? (scopes.includes(scope) ? [...scopes] : [...scopes, scope]) : scopes.filter((s) => s !== scope);

/** What an IRC client (tmi.js and friends) sends: `PASS oauth:<token>`, `NICK <bot login>`. */
export const ircPass = (token: string): string => `oauth:${token}`;

export const TOKEN_KIND_KEYS: Record<AccessTokenDto["kind"], MessageKey> = {
  personal: "developer.token.kind.personal",
  authorization_code: "developer.token.kind.authorization_code",
  device_code: "developer.token.kind.device_code",
  client_credentials: "developer.token.kind.client_credentials",
};
