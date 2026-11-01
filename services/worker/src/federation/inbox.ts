// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The inbox job (ADR 0030 decisions 4 and 5). The API stored the raw request after its cheap
 * checks; here the slow, risky part runs:
 *
 * 1. Re-check the block list (a block may have been added since the API accepted the item).
 * 2. Drop anything that is not `Follow`, `Undo{Follow}` or `Delete` of the sender, before any
 *    outbound request.
 * 3. Fetch the sender's key by `keyId` through the SSRF guard (cached 24 h) and verify the
 *    draft-cavage signature: digest, date skew, the signed host is ours, and the key belongs to
 *    the activity's `actor`. A failure against a cached key refetches it once.
 * 4. Apply: store the follower and send a signed `Accept`; remove the follower; remove a deleted
 *    actor everywhere.
 *
 * The item is marked processed with an outcome (`FEDERATION_INBOX_OUTCOMES`); the sweep deletes
 * items after `FEDERATION_RULES.dropAfterDays`. Remote handles and URLs are never logged.
 */
import { FEDERATION_RULES } from "@commonair/contracts/enums";
import { schema as s, uuidv7 } from "@commonair/db";
import {
  acceptActivity,
  classifyInbound,
  idOf,
  type InboundActivity,
  parseSignatureHeader,
  type SignatureError,
  verifyRequest,
} from "@commonair/federation";
import { sha256Hex } from "@commonair/tokens";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import type { FederationConfig } from "./config.ts";
import { enqueueDeliveries } from "./deliver.ts";
import { fetchActivityJson } from "./http.ts";
import { blockedDomains, federates, isBlocked, loadChannel, localChannelIdOf } from "./local.ts";
import { remoteActor, remoteKey, remoteKeyCacheKey } from "./remote.ts";

export type InboxOutcome = "accepted" | "ignored" | "rejected" | "blocked";

export interface InboxResult {
  outcome: InboxOutcome;
  /** A stable code for tests and metrics (never remote data). */
  reason: string;
}

type Ctx = Pick<WorkerContext, "db" | "valkey" | "logger" | "enqueueBulk" | "now">;

/** The path the remote addressed: the channel's inbox, or the shared inbox. */
export const inboxPath = (channelId: string | null) => (channelId ? `/ap/channels/${channelId}/inbox` : "/ap/inbox");

/** Errors a fresh key could fix (the sender rotated); anything else is final. */
const REFETCH_ON: ReadonlySet<SignatureError> = new Set(["bad_signature", "bad_key", "key_actor_mismatch"]);

export async function runInbox(itemId: string, ctx: Ctx, cfg: FederationConfig): Promise<InboxResult> {
  const [item] = await ctx.db.select().from(s.federationInboxItems).where(eq(s.federationInboxItems.id, itemId));
  if (!item) return { outcome: "ignored", reason: "missing" };
  if (item.processedAt !== null && item.outcome !== null) return { outcome: item.outcome, reason: "already_processed" };

  const result = await processItem(item, ctx, cfg);
  await ctx.db
    .update(s.federationInboxItems)
    .set({ processedAt: ctx.now(), outcome: result.outcome })
    .where(and(eq(s.federationInboxItems.id, itemId), isNull(s.federationInboxItems.processedAt)));
  ctx.logger.info("federation inbox item", { itemId, outcome: result.outcome, reason: result.reason });
  return result;
}

async function processItem(
  item: typeof s.federationInboxItems.$inferSelect,
  ctx: Ctx,
  cfg: FederationConfig,
): Promise<InboxResult> {
  if (!cfg.enabled) return { outcome: "ignored", reason: "disabled" };
  let json: unknown;
  try {
    json = JSON.parse(item.body);
  } catch {
    return { outcome: "rejected", reason: "malformed_body" };
  }
  const headers = Object.fromEntries(Object.entries(item.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const rawSig = headers.signature ?? headers.authorization;
  const sig = rawSig ? parseSignatureHeader(rawSig) : null;
  if (!sig) return { outcome: "rejected", reason: "missing_signature" };
  const inbound = classifyInbound(json);
  const actor = inbound.actor ?? idOf((json as { actor?: unknown } | null)?.actor);
  if (!actor) return { outcome: "rejected", reason: "no_actor" };

  if (isBlocked(await blockedDomains(ctx.db), actor, sig.keyId))
    return { outcome: "blocked", reason: "domain_blocked" };
  // Accepted and dropped, never stored, and no request made on its behalf (decision 5).
  if (inbound.kind === "other") return { outcome: "ignored", reason: "unhandled_type" };

  const host = (headers.host ?? "").toLowerCase();
  if (!cfg.inboxHosts.has(host)) return { outcome: "rejected", reason: "host_mismatch" };
  const req = {
    method: "POST",
    url: `https://${host}${inboxPath(item.channelId)}`,
    headers,
    body: item.body,
  };
  const opts = { now: ctx.now(), skewSeconds: FEDERATION_RULES.dateSkewSeconds, actorId: actor };

  let key = await remoteKey(ctx, cfg, sig.keyId);
  if (!key.ok) {
    // An actor deleting itself often takes its key with it (404/410). The missing key proves
    // nothing (anyone can name a keyId that 404s), so, as Mastodon does, the Delete applies
    // unsigned only when the keyId is on the actor's own origin and the actor's own server says
    // the actor itself is gone.
    if (inbound.kind === "delete-actor" && key.reason === "gone" && (await actorIsGone(cfg, inbound.actor, sig.keyId)))
      return applyDeleteActor(ctx, inbound.actor, "actor_gone");
    return { outcome: "rejected", reason: `key_${key.reason}` };
  }
  let verified = await verifyRequest(req, { publicKey: key.key.publicKeyPem, owner: key.key.owner }, opts);
  if (!verified.ok && key.cached && REFETCH_ON.has(verified.error)) {
    key = await remoteKey(ctx, cfg, sig.keyId, { refresh: true });
    if (!key.ok) return { outcome: "rejected", reason: `key_${key.reason}` };
    verified = await verifyRequest(req, { publicKey: key.key.publicKeyPem, owner: key.key.owner }, opts);
  }
  if (!verified.ok) return { outcome: "rejected", reason: verified.error };

  switch (inbound.kind) {
    case "follow":
      return applyFollow(ctx, cfg, item.channelId, inbound);
    case "undo-follow":
      return applyUndo(ctx, cfg, item.channelId, inbound);
    case "delete-actor":
      return applyDeleteActor(ctx, inbound.actor, "actor_deleted");
  }
}

async function applyFollow(
  ctx: Ctx,
  cfg: FederationConfig,
  inboxChannelId: string | null,
  follow: Extract<InboundActivity, { kind: "follow" }>,
): Promise<InboxResult> {
  const channelId = localChannelIdOf(cfg, follow.object);
  if (!channelId) return { outcome: "ignored", reason: "not_local_actor" };
  if (inboxChannelId !== null && inboxChannelId !== channelId) return { outcome: "ignored", reason: "wrong_inbox" };
  const ch = await loadChannel(ctx.db, cfg, channelId);
  if (!federates(cfg, ch)) return { outcome: "ignored", reason: "not_federated" };

  const remote = await remoteActor(cfg, follow.actor);
  if (!remote.ok) return { outcome: "rejected", reason: `actor_${remote.reason}` };
  const a = remote.actor;
  if (isBlocked(await blockedDomains(ctx.db), a.inbox, ...(a.sharedInbox ? [a.sharedInbox] : [])))
    return { outcome: "blocked", reason: "domain_blocked" };

  const [row] = await ctx.db
    .insert(s.federationFollowers)
    .values({
      id: uuidv7(),
      channelId,
      actorId: a.id,
      inbox: a.inbox,
      sharedInbox: a.sharedInbox,
      handle: a.handle,
      domain: a.domain,
      createdAt: ctx.now(),
    })
    .onConflictDoUpdate({
      target: [s.federationFollowers.channelId, s.federationFollowers.actorId],
      set: { inbox: a.inbox, sharedInbox: a.sharedInbox, handle: a.handle, domain: a.domain },
    })
    .returning({ id: s.federationFollowers.id });
  // Returned by the upsert above.
  if (!row) throw new Error("federation follower row missing after upsert");
  // A verified Follow means the server is back: an inbox the sweep dropped is delivered to again.
  const reachable = [a.inbox, ...(a.sharedInbox ? [a.sharedInbox] : [])];
  await ctx.db
    .delete(s.federationDeliveries)
    .where(and(inArray(s.federationDeliveries.inbox, reachable), eq(s.federationDeliveries.status, "dropped")));
  // The follow's own id is part of the Accept's: a repeat Follow (new id) gets its own Accept,
  // not one deduped against the first by its job id.
  const acceptKey = `${row.id}-${(await sha256Hex(follow.id)).slice(0, 12)}`;
  const accept = acceptActivity(ch.urls, { id: follow.id, type: "Follow", actor: a.id, object: ch.urls.id }, acceptKey);
  await enqueueDeliveries(ctx, channelId, null, accept, [a.inbox]);
  return { outcome: "accepted", reason: "follow" };
}

async function applyUndo(
  ctx: Ctx,
  cfg: FederationConfig,
  inboxChannelId: string | null,
  undo: Extract<InboundActivity, { kind: "undo-follow" }>,
): Promise<InboxResult> {
  const target = undo.object ? localChannelIdOf(cfg, undo.object) : inboxChannelId;
  const where = target
    ? and(eq(s.federationFollowers.actorId, undo.actor), eq(s.federationFollowers.channelId, target))
    : eq(s.federationFollowers.actorId, undo.actor);
  const gone = await ctx.db.delete(s.federationFollowers).where(where).returning({ id: s.federationFollowers.id });
  return { outcome: "accepted", reason: gone.length > 0 ? "unfollow" : "unfollow_unknown" };
}

const originOf = (u: string): string | null => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

/** Whether a fresh GET of the actor answers 404/410 or a Tombstone, with the keyId on its origin. */
async function actorIsGone(cfg: FederationConfig, actorId: string, keyId: string): Promise<boolean> {
  const origin = originOf(actorId);
  if (origin === null || originOf(keyId) !== origin) return false;
  const res = await fetchActivityJson(actorId, cfg);
  if (!res.ok) return res.reason === "gone";
  const doc = res.json as { type?: unknown; id?: unknown } | null;
  return doc !== null && typeof doc === "object" && doc.type === "Tombstone" && (doc.id ?? actorId) === actorId;
}

async function applyDeleteActor(ctx: Ctx, actorId: string, reason: string): Promise<InboxResult> {
  await ctx.db.delete(s.federationFollowers).where(eq(s.federationFollowers.actorId, actorId));
  await ctx.valkey.del(await remoteKeyCacheKey(`${actorId}#main-key`));
  return { outcome: "accepted", reason };
}
