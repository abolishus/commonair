// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure helpers for the `federation` scenario: where this machine reaches the instance's
 * ActivityPub URLs, and which activities the peer's inbox recorded. Unit-tested
 * (`harness/tests/n4/match.test.ts`).
 */
import type { ReceivedActivity } from "../mocks/activitypub/peer.ts";

/**
 * Map an instance URL (its public origin, e.g. the web's port) to the API's own base, which serves
 * `/ap/*` and the `/api/.well-known/*` routes without Caddy. Other URLs pass through.
 */
export function rewriteToApi(url: string, instanceOrigin: string | null, apiUrl: string): string {
  if (!instanceOrigin) return url;
  const origin = instanceOrigin.replace(/\/+$/, "");
  if (url !== origin && !url.startsWith(`${origin}/`) && !url.startsWith(`${origin}#`)) return url;
  return `${apiUrl.replace(/\/+$/, "")}${url.slice(origin.length)}`;
}

/** The WebFinger endpoint as the API serves it (Caddy rewrites `/.well-known/*` under `/api`). */
export const webfingerEndpoint = (apiUrl: string) => `${apiUrl.replace(/\/+$/, "")}/api/.well-known/webfinger`;

const obj = (r: ReceivedActivity): Record<string, unknown> | null => {
  const o = r.json?.object;
  return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
};

/** A verified activity from `actorId`. */
export const signedBy = (r: ReceivedActivity, actorId: string) => r.verified.ok && r.json?.actor === actorId;

/** A verified `Accept` of the given Follow id. */
export const isAcceptOf = (r: ReceivedActivity, actorId: string, followId: string) =>
  signedBy(r, actorId) && r.type === "Accept" && obj(r)?.id === followId;

/** A verified `Create` of a `Note` or `Video` by `actorId`. */
export const isCreate = (r: ReceivedActivity, actorId: string, objectType: "Note" | "Video") =>
  signedBy(r, actorId) && r.type === "Create" && r.objectType === objectType && obj(r)?.attributedTo === actorId;

/** A verified `Delete` of the actor itself. */
export const isActorDelete = (r: ReceivedActivity, actorId: string) =>
  signedBy(r, actorId) && r.type === "Delete" && r.json?.object === actorId;

/** Any `Create` by `actorId`, verified or not (for "nothing delivered" checks). */
export const anyCreateFrom = (r: ReceivedActivity, actorId: string) => r.type === "Create" && r.json?.actor === actorId;

/** `@slug@domain` → `slug@domain`, for `acct:`. */
export const acctOf = (handle: string) => handle.replace(/^@/, "");
