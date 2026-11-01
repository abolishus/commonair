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
 * - `jury.panel.drawn` → nothing (audit only).
 *
 * Federation fan-out is gated twice: `FEDERATION_ENABLED` on the instance and the channel's
 * `federation_settings.enabled`, read in the relay transaction. The fan-out job re-checks both
 * (a setting can change between relay and run); this gate only keeps unfederated channels, the
 * vast majority, from queuing work.
 *
 * Job ids are deterministic per event (no colon: BullMQ refuses a two-part id with one), so a
 * re-relayed batch (at-least-once) enqueues nothing new.
 */
import { federationEnv, loadEnv } from "@commonair/config";
import { EVENTS, type EventType } from "@commonair/contracts/events";
import {
  FEDERATION_JOBS,
  PORTABILITY_JOBS,
  QUEUES,
  RELAY_PURGE_JOBS,
  federationJobId,
  portabilityJobId,
  type FederationFanoutJob,
  type FederationInboxJob,
  type PortabilityMovedJob,
  type RelayPurgeEmitJob,
} from "@commonair/contracts/internal";
import { type Executor, schema } from "@commonair/db";
import { and, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import type { EnqueueOptions } from "../context.ts";
import type { QueueName } from "../env.ts";

const { channels, events } = schema;
type EventRow = typeof events.$inferSelect;

export interface B7Job {
  queue: QueueName;
  name: string;
  data: FederationFanoutJob | FederationInboxJob | PortabilityMovedJob | RelayPurgeEmitJob;
  opts: EnqueueOptions;
}

export interface B7OutboxFlags {
  /** `FEDERATION_ENABLED`. */
  federation: boolean;
}

let cachedFlags: B7OutboxFlags | undefined;

/** Read once per process from the env `workerEnv` validated at start-up; tests pass their own source. */
export function b7OutboxFlags(source?: Record<string, string | undefined>): B7OutboxFlags {
  if (!source && cachedFlags) return cachedFlags;
  const flags = { federation: loadEnv(federationEnv, source ?? process.env).FEDERATION_ENABLED };
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
        opts: { jobId: `${RELAY_PURGE_JOBS.emit}-${row.id}` },
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
      // jury.panel.drawn: audit only, no job.
    }
  }
  return out;
}
