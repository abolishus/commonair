// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Federation (ADR 0030) through the product, against in-harness ActivityPub peers only
 * (`harness/src/mocks/activitypub/`), the way `harness/src/n4/index.ts` runs them: streamer1 turns
 * federation on, the peers follow it (followers and inbox items), one peer is closed, then a VOD's
 * visibility goes private and public again, so the worker writes a federation object and delivers
 * it (ok to the live peers, failing to the closed one). The admin blocks a domain and rotates
 * streamer1's key (`federation_actor_keys` is append-only: only the API writes it).
 */
import type { DbHandle } from "@commonair/db";
import { startActivityPubPeer, type ActivityPubPeer } from "../../mocks/activitypub/peer.ts";
import { isAcceptOf, isCreate, rewriteToApi } from "../../n4/match.ts";
import { waitFor } from "../../wait.ts";
import type { PlatformSessions } from "./api.ts";
import { step } from "./api.ts";
import type { FederationSpec } from "./plan.ts";
import { publicVodOf } from "./write.ts";

const DELIVERY_TIMEOUT_MS = 90_000;

export const FEDERATION_FIX =
  "federation is off on this stack: start api and worker with FEDERATION_ENABLED=true and OUTBOUND_ALLOW_PRIVATE_NETWORKS=true (harness/compose.n4.yaml)";

export interface FederationResult {
  followers: number;
  blocked: string;
  rotated: number;
  notes: string[];
}

/** Everything the federation step does; the peers are closed before it returns. */
export async function seedFederation(
  h: DbHandle,
  sessions: PlatformSessions,
  spec: FederationSpec,
  opts: { apiUrl: string; webhookHost: string; channelId: string; slug: string; signal?: AbortSignal },
): Promise<FederationResult> {
  const apiUrl = opts.apiUrl.replace(/\/+$/, "");
  const owner = await sessions.as(spec.owner);
  const before = await step(spec.owner, "read federation settings", () =>
    owner.api.client.federation.settings.get({ channel: opts.slug }),
  );
  if (!before.instanceEnabled) throw new Error(`seed-platform: ${FEDERATION_FIX}`);
  const settings = await step(spec.owner, "turn federation on", () =>
    owner.api.client.federation.settings.update({ channel: opts.slug, enabled: true }),
  );
  const actorId = settings.actorId;
  if (!actorId) throw new Error("seed-platform: federation settings carry no actor id");
  const instanceOrigin = new URL(actorId).origin;
  const inbox = rewriteToApi(`${actorId}/inbox`, instanceOrigin, apiUrl);
  const peers: { peer: ActivityPubPeer; close: boolean }[] = [];
  const closed = new Set<ActivityPubPeer>();
  try {
    for (const p of spec.peers) {
      const peer = await startActivityPubPeer({
        host: opts.webhookHost,
        username: p.username,
        rewrite: (u) => rewriteToApi(u, instanceOrigin, apiUrl),
      });
      peers.push({ peer, close: p.closeBeforeActivity });
      const { activity, response } = await peer.follow(actorId, inbox);
      if (response.status !== 202)
        throw new Error(`seed-platform: the inbox answered ${response.status} to ${p.username}'s Follow`);
      await peer.waitFor((r) => isAcceptOf(r, actorId, String(activity.id)), DELIVERY_TIMEOUT_MS);
    }
    for (const p of peers.filter((x) => x.close)) {
      closed.add(p.peer);
      await p.peer.close();
    }

    const vod = await publicVodOf(h, opts.channelId);
    if (!vod)
      throw new Error(
        "seed-platform: streamer1 has no public ready VOD for the federation activity (seed-media runs first)",
      );
    const live = peers.filter((x) => !x.close).map((x) => x.peer);
    const from = live.map((p) => p.received.length);
    await step(spec.owner, "make a VOD private", () =>
      owner.api.client.vods.update({ id: vod.id, visibility: "private" }),
    );
    await step(spec.owner, "make the VOD public again", () =>
      owner.api.client.vods.update({ id: vod.id, visibility: "public" }),
    );
    await Promise.all(
      live.map((p, i) =>
        p.waitFor((r) => p.received.indexOf(r) >= (from[i] ?? 0) && isCreate(r, actorId, "Video"), DELIVERY_TIMEOUT_MS),
      ),
    );
    const notes: string[] = [];
    if (peers.some((x) => x.close))
      await waitFor(
        "a failing federation delivery to the closed peer",
        async () => {
          const rows = await h.sql<
            { n: number }[]
          >`select count(*)::int as n from federation_deliveries where status = 'failing'`;
          return Number(rows[0]?.n ?? 0) > 0 || null;
        },
        { timeoutMs: DELIVERY_TIMEOUT_MS, intervalMs: 1_000, signal: opts.signal },
      ).catch(() =>
        notes.push(
          "seed-platform: no failing federation delivery was recorded within 90 s (the closed peer's retry may still be queued)",
        ),
      );

    const admin = await sessions.as("admin");
    await step("admin", "block a federation domain", () =>
      admin.api.client.federation.admin.blocks.add({ domain: spec.blockedDomain }),
    );
    let rotated = 0;
    if (spec.rotateKey)
      rotated = (
        await step("admin", "rotate streamer1's actor key", () =>
          admin.api.client.federation.admin.keys.rotate({ channel: opts.slug }),
        )
      ).rotated;
    return { followers: spec.peers.length, blocked: spec.blockedDomain, rotated, notes };
  } finally {
    await Promise.allSettled(peers.filter((x) => !closed.has(x.peer)).map((x) => x.peer.close()));
  }
}
