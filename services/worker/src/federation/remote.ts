// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Remote actors and their keys (ADR 0030 decisions 4 and 5). A sender's key is fetched by its
 * `keyId` through the SSRF guard and cached for 24 hours in Valkey; the inbox refetches it once
 * when verification fails (the sender may have rotated). Only the fields we use are read, from
 * the two shapes servers publish: an actor document with a `publicKey` block (Mastodon), or a
 * bare key document (`{id, owner, publicKeyPem}`).
 */
import { idOf } from "@commonair/federation";
import { sha256Hex } from "@commonair/tokens";
import type { WorkerContext } from "../context.ts";
import type { FederationConfig } from "./config.ts";
import { fetchActivityJson } from "./http.ts";

/** How long a fetched key is trusted without a refetch. */
export const REMOTE_KEY_TTL_SECONDS = 24 * 60 * 60;
const MAX_PEM = 16 * 1024;

export interface RemoteKey {
  keyId: string;
  owner: string;
  publicKeyPem: string;
}

/** Why a remote fetch gave no usable document; `status` is the HTTP status when one came back. */
export interface RemoteFailure {
  ok: false;
  reason: "rejected" | "gone" | "failed" | "malformed";
  status?: number;
}

export type RemoteKeyResult = { ok: true; key: RemoteKey; cached: boolean } | RemoteFailure;

/** Valkey key of a cached remote key (the keyId hashed: it is a stranger's URL). */
export const remoteKeyCacheKey = async (keyId: string) => `federation:remote-key:${await sha256Hex(keyId)}`;

const withoutFragment = (u: string) => u.split("#")[0] ?? u;

/** The key `keyId` names, from a fetched document, or null when the document does not hold it. */
export function keyFromDocument(keyId: string, doc: unknown): RemoteKey | null {
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;
  const pick = (k: unknown, fallbackOwner: string | null): RemoteKey | null => {
    if (!k || typeof k !== "object") return null;
    const o = k as Record<string, unknown>;
    if (o.id !== keyId || typeof o.publicKeyPem !== "string" || o.publicKeyPem.length > MAX_PEM) return null;
    const owner = idOf(o.owner) ?? fallbackOwner;
    return owner ? { keyId, owner, publicKeyPem: o.publicKeyPem } : null;
  };
  // An actor document: `publicKey` is one key or a list of keys.
  const pk = d.publicKey;
  const actorId = typeof d.id === "string" ? d.id : null;
  for (const k of Array.isArray(pk) ? pk : [pk]) {
    const found = pick(k, actorId);
    if (found) return found;
  }
  // A bare key document.
  return pick(d, null);
}

/** The sender's key: from the cache unless `refresh`, else fetched (and cached). */
export async function remoteKey(
  ctx: Pick<WorkerContext, "valkey">,
  cfg: FederationConfig,
  keyId: string,
  opts: { refresh?: boolean } = {},
): Promise<RemoteKeyResult> {
  const cacheKey = await remoteKeyCacheKey(keyId);
  if (!opts.refresh) {
    const hit = await ctx.valkey.get(cacheKey);
    if (hit) {
      try {
        const k = JSON.parse(hit) as RemoteKey;
        if (k.keyId === keyId && typeof k.owner === "string" && typeof k.publicKeyPem === "string")
          return { ok: true, key: k, cached: true };
      } catch {
        // A corrupt entry is refetched below.
      }
    }
  }
  const res = await fetchActivityJson(withoutFragment(keyId), cfg);
  if (!res.ok) return res;
  const key = keyFromDocument(keyId, res.json);
  if (!key) return { ok: false, reason: "malformed" };
  await ctx.valkey.set(cacheKey, JSON.stringify(key), "EX", REMOTE_KEY_TTL_SECONDS);
  return { ok: true, key, cached: false };
}

export interface RemoteActor {
  id: string;
  inbox: string;
  sharedInbox: string | null;
  /** `@user@host` when the document names a `preferredUsername`. */
  handle: string | null;
  domain: string;
}

const httpUrl = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
};

/** Read an actor document: its id must be `actorId`, and its inbox on the actor's own origin. */
export function actorFromDocument(actorId: string, doc: unknown): RemoteActor | null {
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;
  if (d.id !== actorId) return null;
  const origin = new URL(actorId).origin;
  const inbox = httpUrl(d.inbox);
  if (!inbox || new URL(inbox).origin !== origin) return null;
  const endpoints = d.endpoints && typeof d.endpoints === "object" ? (d.endpoints as Record<string, unknown>) : {};
  const shared = httpUrl(endpoints.sharedInbox);
  const sharedInbox = shared && new URL(shared).origin === origin ? shared : null;
  const domain = new URL(actorId).hostname.toLowerCase();
  const user =
    typeof d.preferredUsername === "string" && /^[\w.-]{1,64}$/.test(d.preferredUsername) ? d.preferredUsername : null;
  return { id: actorId, inbox, sharedInbox, handle: user ? `@${user}@${domain}` : null, domain };
}

export type RemoteActorResult = { ok: true; actor: RemoteActor } | RemoteFailure;

export async function remoteActor(cfg: FederationConfig, actorId: string): Promise<RemoteActorResult> {
  const res = await fetchActivityJson(actorId, cfg);
  if (!res.ok) return res;
  const actor = actorFromDocument(actorId, res.json);
  return actor ? { ok: true, actor } : { ok: false, reason: "malformed" };
}

/**
 * Whether a failed fetch may succeed if tried again: no answer at all (timeout, connection
 * error), a 5xx, 408 or 429. A guard refusal, 404/410, another 4xx or a malformed document is
 * the remote's final word.
 */
export function isTransientFailure(f: Pick<RemoteFailure, "reason" | "status">): boolean {
  if (f.reason !== "failed") return false;
  const st = f.status;
  return st === undefined || st >= 500 || st === 408 || st === 429;
}
