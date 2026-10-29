// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EventSub subscription rules (ADR 0027 §1, §3; E9-subs brief): who may subscribe to what, which
 * app the subscription belongs to and which user's authorization backs it. Pure, so the whole
 * authority table is unit-tested; `index.ts` gathers the facts and runs the database checks.
 */
import { bindingFor, transportsFor, type Binding, backingUserOf } from "@commonair/contracts/eventsub";
import { EVENTS, PUBLIC_EVENT_TYPES, type PublicEventType } from "@commonair/contracts/events";
import type { EVENT_TRANSPORTS, SUBSCRIPTION_STATES } from "@commonair/contracts/enums";

/** Webhook subscriptions one user may hold without an app (personal tokens, bots). */
export const PERSONAL_WEBHOOK_LIMIT = 1000;
/** Webhook subscriptions one app may hold across every user. */
export const APP_WEBHOOK_LIMIT = 10_000;
/** Longest callback URL accepted (the input schema only says "a URL"). */
export const CALLBACK_MAX_LENGTH = 2048;

export type Transport = (typeof EVENT_TRANSPORTS)[number];

/**
 * Who is calling: a signed-in session (optionally acting for an app it owns through `input.appId`),
 * a user access token (an app's, or a personal/bot token with `appId: null`), or an app-only token.
 */
export type Actor =
  | { kind: "session"; userId: string }
  | { kind: "user_token"; userId: string; appId: string | null }
  | { kind: "app_token"; appId: string };

/** A refusal: the oRPC code plus, for PRECONDITION_FAILED, the machine-readable requirement. */
export type Refusal =
  | { code: "FORBIDDEN" | "NOT_FOUND"; message: string }
  | { code: "PRECONDITION_FAILED"; requirement: string; message: string };

/** Whose authorization backs the subscription. `owner`: the app's owner (looked up by the caller). */
export type Backing = { kind: "user"; userId: string } | { kind: "owner" };

export interface Plan {
  /** The app the subscription belongs to (null: personal). For a session, the app still has to be checked as owned. */
  appId: string | null;
  backing: Backing;
  /** Whether `authorizeSubscription` must pass for the backing user (scoped types). */
  authorize: boolean;
  binding: Binding;
  /** The app acts without a user (app token, or a session for its app): refusals name the broadcaster. */
  asApp: boolean;
}

export const isPublicEventType = (t: string): t is PublicEventType =>
  (PUBLIC_EVENT_TYPES as readonly string[]).includes(t);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const precondition = (requirement: string, message: string): Refusal => ({
  code: "PRECONDITION_FAILED",
  requirement,
  message,
});

/** Version and condition keys: exactly the catalog's, each non-empty. */
export function checkTypeAndCondition(
  type: PublicEventType,
  version: string,
  condition: Record<string, string>,
): Refusal | null {
  const def = EVENTS[type];
  if (version !== def.version) return precondition("version", `${type} has version ${def.version} only`);
  const expected: readonly string[] = def.condition;
  const keys = Object.keys(condition);
  const unknown = keys.filter((k) => !expected.includes(k));
  if (unknown.length > 0) return precondition("condition_keys", `Unknown condition fields: ${unknown.join(", ")}`);
  const missing = expected.filter((k) => !Object.hasOwn(condition, k) || condition[k] === "");
  if (missing.length > 0) return precondition("condition_keys", `Missing condition fields: ${missing.join(", ")}`);
  // User ids are UUIDs; anything else would reach uuid columns (authorization lookups) and fail there.
  const notIds = keys.filter((k) => k.endsWith("user_id") && !UUID.test(condition[k] ?? ""));
  if (notIds.length > 0) return precondition("condition_keys", `Not a user id: ${notIds.join(", ")}`);
  return null;
}

/**
 * The authority table. `inputAppId` is `subscribe`'s `appId` (session callers only). The result's
 * `backing` names the user `authorizeSubscription` must pass for when `authorize` is set.
 */
export function planSubscription(
  actor: Actor,
  input: { type: PublicEventType; condition: Record<string, string>; transport: Transport; appId?: string | undefined },
): Plan | Refusal {
  if (input.appId !== undefined && actor.kind !== "session")
    return { code: "FORBIDDEN", message: "appId is for signed-in sessions; a token subscribes for its own app" };
  if (!transportsFor(input.type).includes(input.transport))
    return precondition("websocket_only", `${input.type} is delivered over the WebSocket transport only`);
  if (input.transport === "websocket" && actor.kind !== "user_token")
    return { code: "FORBIDDEN", message: "WebSocket subscriptions need a user access token" };

  const binding = bindingFor(EVENTS[input.type].scopes);
  const appId = actor.kind === "session" ? (input.appId ?? null) : actor.appId;
  // An app acting without a user: a session for an app it owns, or an app-only token.
  const asApp = actor.kind === "app_token" || (actor.kind === "session" && appId !== null);

  if (binding === "none")
    return actor.kind === "app_token" || asApp
      ? { appId, backing: { kind: "owner" }, authorize: false, binding, asApp }
      : { appId, backing: { kind: "user", userId: actor.userId }, authorize: false, binding, asApp };

  if (actor.kind === "session" && appId === null)
    return precondition(
      "token_required",
      `${input.type} needs an authorization: subscribe with an access token that has ${EVENTS[input.type].scopes.join(", ")}`,
    );
  if (actor.kind === "user_token")
    return { appId, backing: { kind: "user", userId: actor.userId }, authorize: true, binding, asApp };
  const backer = backingUserOf(input.type, input.condition);
  if (!backer) return precondition("condition_keys", "The condition names no broadcaster");
  return { appId, backing: { kind: "user", userId: backer }, authorize: true, binding, asApp };
}

export const isRefusal = (p: Plan | Refusal): p is Refusal => "code" in p;

/** What one refused `authorizeSubscription` means to the caller. */
export function unauthorizedRefusal(type: PublicEventType, asApp: boolean): Refusal {
  const scopes = EVENTS[type].scopes.join(", ");
  return {
    code: "FORBIDDEN",
    message: asApp
      ? `The broadcaster has not authorized this app for ${scopes}`
      : `Your authorization does not cover ${type}: it needs ${scopes} and a condition naming you as broadcaster${
          bindingFor(EVENTS[type].scopes) === "broadcaster_or_moderator" ? " or moderator" : ""
        }`,
  };
}

export interface SubscriptionRowLike {
  id: string;
  appId: string | null;
  userId: string;
  type: string;
  version: string;
  condition: Record<string, string>;
  transport: Transport;
  callbackUrl: string | null;
  websocketSessionId: string | null;
  status: (typeof SUBSCRIPTION_STATES)[number];
  failureCount: number;
  createdAt: Date;
}

/** The `EventSubscription` DTO. Never the secret. */
export function toSubscriptionDto(r: SubscriptionRowLike) {
  return {
    id: r.id,
    appId: r.appId,
    userId: r.userId,
    type: r.type,
    version: r.version,
    condition: r.condition,
    transport:
      r.transport === "webhook"
        ? { method: "webhook" as const, callback: r.callbackUrl ?? "" }
        : { method: "websocket" as const, sessionId: r.websocketSessionId ?? "" },
    status: r.status,
    failureCount: r.failureCount,
    createdAt: r.createdAt.toISOString(),
  };
}

/** `developer.events.catalog`: static, built once. */
export const CATALOG = PUBLIC_EVENT_TYPES.map((type) => ({
  type,
  version: EVENTS[type].version,
  condition: [...EVENTS[type].condition],
  scopes: [...EVENTS[type].scopes],
  transports: transportsFor(type),
  description: EVENTS[type].description,
}));
