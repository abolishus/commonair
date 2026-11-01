// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The batch 7 job stubs are registered on their queues (contract step §5.1), and the outbox mapping (§5.2). */
import {
  FEDERATION_JOBS,
  GIVEAWAY_JOBS,
  JURY_JOBS,
  PORTABILITY_JOBS,
  QUEUES,
  RELAY_PURGE_JOBS,
  TWITCH_JOBS,
  WATCH_ROOM_JOBS,
} from "@commonair/contracts/internal";
import { schema, uuidv7, type Executor } from "@commonair/db";
import { describe, expect, test } from "vite-plus/test";
import { b7JobsFor, b7OutboxFlags } from "../src/b7/outbox-jobs.ts";
import { stubHandler } from "../src/b7/stub.ts";
import { JOBS } from "../src/jobs/index.ts";
import { buildRegistry, scheduledJobs } from "../src/runtime/registry.ts";

describe("batch 7 jobs", () => {
  const reg = buildRegistry(JOBS);
  const names = (queue: string) => [...(reg.get(queue as never)?.keys() ?? [])].sort();

  test("every batch 7 job has a handler on its queue", () => {
    expect(names(QUEUES.watchRooms)).toEqual([WATCH_ROOM_JOBS.retention]);
    expect(names(QUEUES.portability)).toEqual(
      [...Object.values(PORTABILITY_JOBS), ...Object.values(TWITCH_JOBS)].sort(),
    );
    expect(names(QUEUES.jury)).toEqual(Object.values(JURY_JOBS).sort());
    expect(names(QUEUES.federation)).toEqual(Object.values(FEDERATION_JOBS).sort());
    expect(names(QUEUES.relayPurge)).toEqual([RELAY_PURGE_JOBS.emit, `${RELAY_PURGE_JOBS.emit}-cleanup`].sort());
    expect(reg.get(QUEUES.interact)?.has(GIVEAWAY_JOBS.close)).toBe(true);
  });

  test("retention runs daily, the jury draw monthly, federation upkeep daily; the rest are event-driven", () => {
    const b7Queues = new Set<string>([
      QUEUES.watchRooms,
      QUEUES.portability,
      QUEUES.jury,
      QUEUES.federation,
      QUEUES.relayPurge,
    ]);
    const scheduled = scheduledJobs(reg)
      .filter((j) => b7Queues.has(j.queue))
      .map((j) => [j.name, j.schedule]);
    const byName = (a: unknown[], b: unknown[]) => String(a[0]).localeCompare(String(b[0]));
    expect(scheduled.sort(byName)).toEqual(
      [
        [WATCH_ROOM_JOBS.retention, { pattern: "29 3 * * *" }],
        [JURY_JOBS.draw, { pattern: "11 6 1 * *" }],
        [FEDERATION_JOBS.rotate, { pattern: "37 4 * * *" }],
        [FEDERATION_JOBS.sweep, { pattern: "47 4 * * *" }],
        [`${RELAY_PURGE_JOBS.emit}-cleanup`, { pattern: "53 3 * * *" }],
      ].sort(byName),
    );
    expect(reg.get(QUEUES.interact)?.get(GIVEAWAY_JOBS.close)?.schedule).toBeUndefined();
  });

  test("payloads are the contract's", () => {
    const id = crypto.randomUUID();
    const ok = (queue: string, name: string, data: unknown) =>
      reg
        .get(queue as never)
        ?.get(name)
        ?.data.safeParse(data).success;
    expect(ok(QUEUES.portability, PORTABILITY_JOBS.moved, { channelId: id, eventId: id })).toBe(true);
    expect(ok(QUEUES.portability, PORTABILITY_JOBS.moved, { channelId: id })).toBe(false);
    expect(ok(QUEUES.federation, FEDERATION_JOBS.fanout, { eventId: id })).toBe(true);
    expect(ok(QUEUES.federation, FEDERATION_JOBS.inbox, { itemId: "nope" })).toBe(false);
    expect(ok(QUEUES.relayPurge, RELAY_PURGE_JOBS.emit, { eventId: id })).toBe(true);
    expect(ok(QUEUES.interact, GIVEAWAY_JOBS.close, { giveawayId: id })).toBe(true);
    expect(ok(QUEUES.jury, JURY_JOBS.close, {})).toBe(true);
  });

  test("a stub handler completes with a count and touches nothing", async () => {
    // Tested directly: every W3 job is real now, and the stub stays for the wave 2 units.
    const handler = stubHandler("x");
    const logs: unknown[] = [];
    const ctx = { logger: { debug: (...a: unknown[]) => logs.push(a) } } as never;
    expect(await handler({}, ctx)).toEqual({ stub: 1 });
    expect(logs).toHaveLength(1);
  });
});

type Row = typeof schema.events.$inferSelect;
const row = (type: string, payload: Record<string, unknown>, channelId: string | null = null): Row => ({
  id: uuidv7(),
  type,
  version: "1",
  channelId,
  payload,
  occurredAt: new Date(),
  publishedAt: null,
});

/** A transaction whose only query (the federated-channel lookup) answers `federated`; it records whether it ran. */
function fakeTx(federated: string[]) {
  const calls = { selects: 0 };
  const tx = {
    select: () => ({
      from: () => ({
        where: async () => {
          calls.selects++;
          return federated.map((id) => ({ id }));
        },
      }),
    }),
  } as unknown as Executor;
  return { tx, calls };
}

describe("b7JobsFor", () => {
  const A = uuidv7();
  const B = uuidv7();
  const now = new Date();
  const on = { federation: true };
  const off = { federation: false };
  const online = (channelId: string) =>
    row(
      "stream.online",
      {
        broadcaster_user_id: uuidv7(),
        broadcaster_user_login: "a",
        broadcaster_user_name: "a",
        id: uuidv7(),
        type: "live",
        started_at: now.toISOString(),
      },
      channelId,
    );
  const vod = (channelId: string, isPublic: boolean) =>
    row("media.vod.state", { vod_id: uuidv7(), channel_id: channelId, public: isPublic, reason: "moderation" });
  const clip = (channelId: string, isPublic: boolean) =>
    row("media.clip.state", { clip_id: uuidv7(), channel_id: channelId, public: isPublic, reason: "visibility" });
  const suspension = (channelId: string, suspended: boolean) =>
    row("channel.suspension", { channel_id: channelId, suspended });
  const restriction = (channelId: string, restricted: boolean) =>
    row("moderation.restriction", {
      broadcast_id: uuidv7(),
      channel_id: channelId,
      case_id: uuidv7(),
      restricted,
    });

  test("federation fan-out only for a federated channel, and only with FEDERATION_ENABLED", async () => {
    const rows = [online(A), online(B), vod(A, true), clip(A, true), suspension(A, false), restriction(A, false)];
    const { tx, calls } = fakeTx([A]);
    const jobs = await b7JobsFor(tx, rows, now, on);
    expect(jobs.filter((j) => j.name === FEDERATION_JOBS.fanout).map((j) => j.data)).toEqual(
      [rows[0], rows[2], rows[3], rows[4], rows[5]].map((r) => ({ eventId: r!.id })),
    );
    expect(calls.selects).toBe(1);

    const offTx = fakeTx([A]);
    expect(await b7JobsFor(offTx.tx, rows, now, off)).toEqual([]);
    // The instance flag off never costs a query.
    expect(offTx.calls.selects).toBe(0);
  });

  test("relay purges for media going off the air only, never for a clip", async () => {
    const rows = [
      vod(B, false),
      vod(B, true),
      clip(B, false),
      suspension(B, true),
      suspension(B, false),
      restriction(B, true),
      restriction(B, false),
      row(
        "stream.offline",
        { broadcaster_user_id: uuidv7(), broadcaster_user_login: "b", broadcaster_user_name: "b" },
        B,
      ),
    ];
    const jobs = await b7JobsFor(fakeTx([]).tx, rows, now, off);
    expect(jobs).toEqual(
      [rows[0], rows[3], rows[5], rows[7]].map((r) => ({
        queue: QUEUES.relayPurge,
        name: RELAY_PURGE_JOBS.emit,
        data: { eventId: r!.id },
        opts: { jobId: `relay-purge-${r!.id}` },
      })),
    );
  });

  test("a federated removal both fans out and purges", async () => {
    const r = vod(A, false);
    const jobs = await b7JobsFor(fakeTx([A]).tx, [r], now, on);
    expect(jobs.map((j) => [j.queue, j.name])).toEqual([
      [QUEUES.federation, FEDERATION_JOBS.fanout],
      [QUEUES.relayPurge, RELAY_PURGE_JOBS.emit],
    ]);
  });

  test("channel.moved, the inbox and the jury draw", async () => {
    const itemId = uuidv7();
    const moved = row("channel.moved", { channel_id: A, moved_to: "https://elsewhere.example/a" });
    const inbox = row("federation.inbox.received", { item_id: itemId });
    const drawn = row("jury.panel.drawn", { panel_id: uuidv7() });
    expect(await b7JobsFor(fakeTx([]).tx, [moved, inbox, drawn], now, off)).toEqual([
      {
        queue: QUEUES.portability,
        name: PORTABILITY_JOBS.moved,
        data: { channelId: A, eventId: moved.id },
        opts: { jobId: `portability-moved-${moved.id}` },
      },
      {
        queue: QUEUES.federation,
        name: FEDERATION_JOBS.inbox,
        data: { itemId },
        opts: { jobId: `federation-inbox-${itemId}` },
      },
    ]);
  });

  test("other events start nothing; job ids are ones BullMQ accepts", async () => {
    const rows = [
      row("channel.follow", {}),
      online(A),
      vod(A, false),
      row("channel.moved", { channel_id: A, moved_to: "https://x.example" }),
    ];
    const jobs = await b7JobsFor(fakeTx([A]).tx, rows, now, on);
    expect(jobs.length).toBe(4);
    for (const j of jobs) expect(j.opts.jobId).not.toContain(":");
    // Deterministic: the same rows map to the same ids (a re-relayed batch enqueues nothing new).
    const again = await b7JobsFor(fakeTx([A]).tx, rows, now, on);
    expect(again.map((j) => j.opts.jobId)).toEqual(jobs.map((j) => j.opts.jobId));
  });

  test("the flag is read through loadEnv", () => {
    expect(b7OutboxFlags({ FEDERATION_ENABLED: "true" })).toEqual({ federation: true });
    expect(b7OutboxFlags({ FEDERATION_ENABLED: "" })).toEqual({ federation: false });
    expect(b7OutboxFlags({})).toEqual({ federation: false });
  });
});
