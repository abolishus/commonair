// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The outbox relay's batch 7 hook (contract step §5.2, decision (z)): which jobs a relayed batch
 * starts. Internal rows reach it as well as public ones.
 *
 * - `stream.online` → `federation-fanout` (a `Note`).
 * - `media.vod.state`, `media.clip.state`, `channel.suspension`, `moderation.restriction` →
 *   `federation-fanout`, and → `relay-purge` when media stops being served: a VOD going
 *   non-public, a restriction imposed, a suspension imposed (W3-dvr-relay). A clip is never
 *   served from a relay's DVR, so a clip state starts no purge.
 * - `stream.offline` → `relay-purge` (the job decides whether a recording ended).
 * - `channel.moved` → `portability-moved`.
 * - `federation.inbox.received` → `federation-inbox`.
 * - `federation.actor.disabled` → `federation-deliver` of the actor `Delete`, one job per distinct
 *   follower inbox (batch 8, decision (h)).
 * - `channel.federation {enabled:false}` → the same `Delete` deliveries, plus
 *   `federation-follower-cleanup`, queued in the same bulk so every follower it removes already
 *   has its `Delete` queued. `{enabled:true}` starts nothing.
 * - `jury.panel.drawn` → nothing (audit only).
 *
 * Federation fan-out is gated twice: `FEDERATION_ENABLED` on the instance and the channel's
 * `federation_settings.enabled`, read in the relay transaction. The fan-out job re-checks both
 * (a setting can change between relay and run); this gate only keeps unfederated channels, the
 * vast majority, from queuing work.
 *
 * Job ids are deterministic per event (no colon: BullMQ refuses a two-part id with one), so a
 * re-relayed batch (at-least-once) enqueues nothing new. The actor `Delete` is the exception: its
 * activity id, and so each delivery's job id (`deliverJobId`), is stable per channel and key
 * generation, so the two events written for one change (or a repeat) queue one `Delete` per inbox.
 * Both read the actor and its followers in the relay transaction; a channel with no actor row (an
 * account deletion removes it) has nobody to tell from here.
 */
import { EVENTS, type EventType } from "@commonair/contracts/events";
import {
  FEDERATION_JOBS,
  PORTABILITY_JOBS,
  QUEUES,
  RELAY_PURGE_JOBS,
  relayPurgeJobId,
  federationJobId,
  portabilityJobId,
  type FederationDeliverJob,
  type FederationFanoutJob,
  type FederationInboxJob,
  type PortabilityMovedJob,
  type RelayPurgeEmitJob,
} from "@commonair/contracts/internal";
import { type Executor, schema } from "@commonair/db";
import { actorUrls, deleteActorActivity } from "@commonair/federation";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import type { EnqueueOptions } from "../context.ts";
import type { QueueName } from "../env.ts";
import { federationEnvSlice } from "../federation/config.ts";
import { deliverJobId } from "../federation/deliver.ts";
import { blockedDomains, isBlocked } from "../federation/local.ts";
import { FEDERATION_FOLLOWER_CLEANUP, type FederationFollowerCleanupJob } from "../jobs/names.ts";

const { channels, events, federationActors, federationFollowers } = schema;
type EventRow = typeof events.$inferSelect;

export interface B7Job {
  queue: QueueName;
  name: string;
  data:
    | FederationFanoutJob
    | FederationInboxJob
    | FederationDeliverJob
    | FederationFollowerCleanupJob
    | PortabilityMovedJob
    | RelayPurgeEmitJob;
  opts: EnqueueOptions;
}

export interface B7OutboxFlags {
  /** `FEDERATION_ENABLED`. */
  federation: boolean;
  /** The instance's public origin, which actor ids are built on (the site's `publicUrl`). */
  publicUrl: string;
}

let cachedFlags: B7OutboxFlags | undefined;

/** Read once per process from the env `workerEnv` validated at start-up; tests pass their own source. */
export function b7OutboxFlags(source?: Record<string, string | undefined>): B7OutboxFlags {
  if (!source && cachedFlags) return cachedFlags;
  const env = federationEnvSlice(source ?? process.env);
  // The same derivation as `instanceSite` and `federationConfig`'s fallback.
  const flags = { federation: env.FEDERATION_ENABLED, publicUrl: env.PUBLIC_URL.replace(/\/+$/, "") };
  if (!source) cachedFlags = flags;
  return flags;
}

const payloadOf = <T extends EventType>(type: T, row: EventRow) =>
  EVENTS[type].payload.parse(row.payload) as z.output<(typeof EVENTS)[T]["payload"]>;

/** Event types the federation fan-out handles. */
const FEDERATED_TYPES: ReadonlySet<string> = new Set<EventType>([
  "stream.online",
  "media.vod.state",
  "media.clip.state",
  "channel.suspension",
  "moderation.restriction",
]);

/** The channel a federation-relevant row is about: the payload's `channel_id`, else the row's. */
function channelOf(row: EventRow): string | null {
  const p = row.payload as { channel_id?: unknown } | null;
  return typeof p?.channel_id === "string" ? p.channel_id : row.channelId;
}

/** Of `ids`, the channels whose streamer turned federation on. */
async function federatedChannels(tx: Executor, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: channels.id })
    .from(channels)
    .where(and(inArray(channels.id, [...ids]), sql`(${channels.federationSettings} ->> 'enabled')::boolean`));
  return new Set(rows.map((r) => r.id));
}

/** What an actor `Delete` needs from the relay transaction: the key generation and the inboxes. */
export interface ActorDeleteTarget {
  /** `federation_actors.key_created_at`: a rotation starts a new generation. */
  keyCreatedAt: Date;
  /** Distinct inboxes (shared where offered) of the followers who arrived by `upTo`, unblocked. */
  inboxes: string[];
}

/**
 * The channel's actor and the follower inboxes to tell, as of `upTo` (the event's time: a
 * follower who arrived after federation came back on is not told). Null without an actor row.
 */
export async function actorDeleteTarget(
  tx: Executor,
  channelId: string,
  upTo: Date,
): Promise<ActorDeleteTarget | null> {
  const [actor] = await tx
    .select({ keyCreatedAt: federationActors.keyCreatedAt })
    .from(federationActors)
    .where(eq(federationActors.channelId, channelId));
  if (!actor) return null;
  const [rows, blocks] = await Promise.all([
    tx
      .select({ inbox: federationFollowers.inbox, sharedInbox: federationFollowers.sharedInbox })
      .from(federationFollowers)
      .where(
        and(
          eq(federationFollowers.channelId, channelId),
          // `upTo` has milliseconds; created_at has microseconds.
          sql`date_trunc('milliseconds', ${federationFollowers.createdAt}) <= ${upTo.toISOString()}::timestamptz`,
        ),
      ),
    blockedDomains(tx),
  ]);
  const inboxes = new Set<string>();
  for (const r of rows) {
    const target = r.sharedInbox ?? r.inbox;
    if (!isBlocked(blocks, target)) inboxes.add(target);
  }
  return { keyCreatedAt: actor.keyCreatedAt, inboxes: [...inboxes].sort() };
}

/**
 * The actor `Delete` deliveries (attempt 1): one per inbox, the activity id stable per channel and
 * key generation (`#delete/key-<ms>`), so `deliverJobId` is too.
 */
export async function actorDeleteJobs(
  publicUrl: string,
  channelId: string,
  target: ActorDeleteTarget,
): Promise<B7Job[]> {
  const activity = deleteActorActivity(actorUrls(publicUrl, channelId), `key-${target.keyCreatedAt.getTime()}`);
  // The builders return closed interfaces; the job carries the activity as a JSON record.
  const json = activity as unknown as Record<string, unknown>;
  return Promise.all(
    target.inboxes.map(async (inbox) => ({
      queue: QUEUES.federation,
      name: FEDERATION_JOBS.deliver,
      data: { channelId, inbox, objectId: null, activity: json, attempt: 1 } satisfies FederationDeliverJob,
      opts: { jobId: await deliverJobId(activity.id, inbox, 1) },
    })),
  );
}

/** Whether a row takes media off the air (so relays must drop their copies). */
function purges(row: EventRow): boolean {
  switch (row.type) {
    case "media.vod.state":
      return !payloadOf("media.vod.state", row).public;
    case "moderation.restriction":
      return payloadOf("moderation.restriction", row).restricted;
    case "channel.suspension":
      return payloadOf("channel.suspension", row).suspended;
    case "stream.offline":
      return true;
    default:
      return false;
  }
}

/**
 * Jobs for the relayed rows (validated already; internal events included). Runs in the relay
 * transaction. `now` is unused today; it is here so a unit can delay a job without a new seam.
 */
export async function b7JobsFor(
  tx: Executor,
  rows: readonly EventRow[],
  _now: Date,
  flags: B7OutboxFlags = b7OutboxFlags(),
  targetOf: typeof actorDeleteTarget = actorDeleteTarget,
): Promise<B7Job[]> {
  const candidates = flags.federation
    ? [...new Set(rows.filter((r) => FEDERATED_TYPES.has(r.type)).flatMap((r) => channelOf(r) ?? []))]
    : [];
  const federated = await federatedChannels(tx, candidates);

  const out: B7Job[] = [];
  for (const row of rows) {
    if (FEDERATED_TYPES.has(row.type)) {
      const channelId = channelOf(row);
      if (channelId && federated.has(channelId))
        out.push({
          queue: QUEUES.federation,
          name: FEDERATION_JOBS.fanout,
          data: { eventId: row.id },
          opts: { jobId: federationJobId(FEDERATION_JOBS.fanout, row.id) },
        });
    }
    if (purges(row))
      out.push({
        queue: QUEUES.relayPurge,
        name: RELAY_PURGE_JOBS.emit,
        data: { eventId: row.id },
        opts: { jobId: relayPurgeJobId(RELAY_PURGE_JOBS.emit, row.id) },
      });
    switch (row.type) {
      case "channel.moved": {
        const p = payloadOf("channel.moved", row);
        out.push({
          queue: QUEUES.portability,
          name: PORTABILITY_JOBS.moved,
          data: { channelId: p.channel_id, eventId: row.id },
          opts: { jobId: portabilityJobId(PORTABILITY_JOBS.moved, row.id) },
        });
        break;
      }
      case "federation.inbox.received": {
        const p = payloadOf("federation.inbox.received", row);
        out.push({
          queue: QUEUES.federation,
          name: FEDERATION_JOBS.inbox,
          data: { itemId: p.item_id },
          opts: { jobId: federationJobId(FEDERATION_JOBS.inbox, p.item_id) },
        });
        break;
      }
      case "federation.actor.disabled": {
        if (!flags.federation) break;
        const p = payloadOf("federation.actor.disabled", row);
        const target = await targetOf(tx, p.channel_id, row.occurredAt);
        if (target) out.push(...(await actorDeleteJobs(flags.publicUrl, p.channel_id, target)));
        break;
      }
      case "channel.federation": {
        const p = payloadOf("channel.federation", row);
        if (!flags.federation || p.enabled) break;
        const target = await targetOf(tx, p.channel_id, row.occurredAt);
        if (!target) break;
        out.push(...(await actorDeleteJobs(flags.publicUrl, p.channel_id, target)));
        out.push({
          queue: QUEUES.federation,
          name: FEDERATION_FOLLOWER_CLEANUP,
          data: { channelId: p.channel_id, upTo: row.occurredAt.toISOString() },
          opts: { jobId: federationJobId(FEDERATION_FOLLOWER_CLEANUP, row.id) },
        });
        break;
      }
      // jury.panel.drawn: audit only, no job.
    }
  }
  // Both actor events for one change name the same deliveries; keep the first of each.
  const seen = new Set<string>();
  return out.filter((j) => {
    const id = j.opts.jobId;
    if (id === undefined) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
