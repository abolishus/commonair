// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Batch 7 contract step (W3, N3, N4): enums, settings shapes, chat frames, events, internal shapes, procedures. */
import type { z } from "zod";
import { describe, expect, test } from "vite-plus/test";
import {
  Channel,
  InstanceInfo,
  PredictionView,
  RELAY_PURGE_REASON,
  RelayPurgeBatch,
  RelayPurgeFeed,
  SurgeState,
} from "../src/api/entities.ts";
import { contract } from "../src/api/router.ts";
import {
  CHAT_LIMITS,
  ChatControlMessage,
  ClientFrame,
  NOTICE_CODES,
  RoomControlMessage,
  ServerFrame,
} from "../src/chat.ts";
import {
  EXPORT_KINDS,
  FOLLOW_SOURCES,
  GIVEAWAY_RULES,
  JURY_RULES,
  MOVE_LINK_RULES,
  RAID_RULES,
  RELAY_PURGE_REASONS,
  REPORT_SUBJECTS,
  ROOM_AGE_BANDS,
  ROOM_LIMITS,
  UNSUBSCRIBE_LISTS,
} from "../src/enums.ts";
import { BUS, EVENTS, PUBLIC_EVENT_TYPES, isInternalEvent } from "../src/events.ts";
import {
  B7TickBody,
  FEDERATION_JOBS,
  INTERNAL_ROUTES,
  KEYS,
  QUEUES,
  UploadCommitBody,
  UploadCommitResult,
} from "../src/internal.ts";
import {
  ChannelChatSettings,
  ChannelChatSettingsPatch,
  ChannelFederationSettings,
  ChannelFederationSettingsPatch,
  GiveawayEligibility,
  JuryPanelSizeSetting,
} from "../src/shapes.ts";

const id = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const input = (p: { "~orpc": { inputSchema?: unknown } }) => p["~orpc"].inputSchema as z.ZodType;

describe("enums", () => {
  test("rules and new values", () => {
    expect(REPORT_SUBJECTS).toContain("watch_room");
    expect(ROOM_AGE_BANDS).toEqual(["minor", "adult"]);
    expect(ROOM_LIMITS).toEqual({ maxMembers: 8, emptyEndMinutes: 10, retentionDays: 30, edgeCapSeconds: 5 });
    expect(FOLLOW_SOURCES).toEqual(["direct", "move_link", "import"]);
    expect(MOVE_LINK_RULES).toEqual({ maxActive: 10, perDay: 20 });
    expect(UNSUBSCRIBE_LISTS).toContain("moved");
    expect(EXPORT_KINDS).toContain("bundle");
    expect(GIVEAWAY_RULES).toEqual({ maxWinners: 10, maxOpenPerChannel: 1, maxDurationMinutes: 1440 });
    expect(JURY_RULES).toEqual({ panelSize: 7, casesPerPanel: 20, sampleDays: 30, k: 10 });
    expect(RAID_RULES.surgeMinutes).toBe(10);
    expect(RAID_RULES.carryMinutes).toBe(10);
  });
});

describe("settings shapes", () => {
  test("surgeGuard.onRaid defaults on and patches alone", () => {
    expect(ChannelChatSettings.parse({ surgeGuard: { enabled: true } }).surgeGuard.onRaid).toBe(true);
    expect(ChannelChatSettingsPatch.parse({ surgeGuard: { onRaid: false } })).toEqual({
      surgeGuard: { onRaid: false },
    });
  });

  test("federation is off by default; the patch carries no default", () => {
    expect(ChannelFederationSettings.parse({})).toEqual({ enabled: false });
    expect(ChannelFederationSettingsPatch.parse({})).toEqual({});
  });

  test("giveaway eligibility cannot express a subscription, points or payment criterion", () => {
    expect(GiveawayEligibility.parse({})).toEqual({
      minAccountAgeDays: 0,
      minFollowDays: null,
      minVerifiedWatchSeconds: 0,
    });
    for (const extra of [{ subscribersOnly: true }, { minPoints: 100 }, { paid: true }, { tier: 1 }])
      expect(GiveawayEligibility.safeParse(extra).success).toBe(false);
    const open = input(contract.interact.giveaways.open);
    expect(open.safeParse({ channel: "sam", title: "t", prize: "p", winnerCount: 1, entryCost: 5 }).success).toBe(true);
    expect(
      open.safeParse({ channel: "sam", title: "t", prize: "p", winnerCount: 11 }).success,
      "at most GIVEAWAY_RULES.maxWinners",
    ).toBe(false);
    expect(
      open.safeParse({ channel: "sam", title: "t", prize: "p", winnerCount: 1, eligibility: { minPoints: 1 } }).success,
    ).toBe(false);
  });

  test("jury settings are range-checked", () => {
    expect(JuryPanelSizeSetting.safeParse({ panelSize: 7 }).success).toBe(true);
    expect(JuryPanelSizeSetting.safeParse({ panelSize: 2 }).success).toBe(false);
  });
});

describe("chat protocol", () => {
  test("room frames parse", () => {
    const roomId = id(1);
    expect(ClientFrame.parse({ op: "room.join", roomId, token: "t" }).op).toBe("room.join");
    expect(ClientFrame.parse({ op: "room.part", roomId }).op).toBe("room.part");
    expect(
      ClientFrame.safeParse({ op: "room.send", roomId, body: "x".repeat(CHAT_LIMITS.room.maxBodyLength + 1) }).success,
    ).toBe(false);
    expect(
      ClientFrame.parse({ op: "room.sync", roomId, playheadWallclock: "2026-11-01T10:00:00.000Z", mode: "live" }).op,
    ).toBe("room.sync");
    const member = { id: id(2), username: "ann", displayName: "Ann", avatarUrl: null };
    expect(ServerFrame.parse({ op: "room.state", roomId, hostId: id(2), ageBand: "adult", members: [member] }).op).toBe(
      "room.state",
    );
    expect(
      ServerFrame.safeParse({
        op: "room.state",
        roomId,
        hostId: id(2),
        ageBand: "adult",
        members: Array(9).fill(member),
      }).success,
    ).toBe(false);
    expect(ServerFrame.parse({ op: "room.sync", roomId, target: "2026-11-01T10:00:00Z" }).op).toBe("room.sync");
    expect(ServerFrame.parse({ op: "room.closed", roomId, reason: "host_closed" }).op).toBe("room.closed");
    for (const c of ["room_age_band", "room_blocked", "room_banned", "room_full", "room_closed"])
      expect(NOTICE_CODES).toContain(c);
  });

  test("room control is its own bus message, never a channel control frame", () => {
    expect(RoomControlMessage.parse({ op: "room.kick", roomId: id(1), userId: id(2), reason: "banned" }).op).toBe(
      "room.kick",
    );
    expect(ChatControlMessage.safeParse({ op: "room.closed", roomId: id(1), reason: "empty" }).success).toBe(false);
    expect(BUS.room(id(1))).toBe(`room:${id(1)}`);
    expect(BUS.roomControl).toBe("bus:room-control");
  });
});

describe("events", () => {
  test("media-state, suspension, move, import, jury and inbox events are internal", () => {
    for (const t of [
      "media.vod.state",
      "media.clip.state",
      "channel.suspension",
      "channel.moved",
      "portability.import.finished",
      "jury.panel.drawn",
      "federation.inbox.received",
    ])
      expect(isInternalEvent(t)).toBe(true);
    expect(
      EVENTS["media.vod.state"].payload.safeParse({ vod_id: id(1), channel_id: id(2), public: false, reason: "dmca" })
        .success,
    ).toBe(true);
    expect(EVENTS["chat.surge.begin"].payload.shape.trigger.options).toContain("raid");
  });

  test("the giveaway events are public, in the EventSub catalog", () => {
    expect(PUBLIC_EVENT_TYPES).toContain("channel.giveaway.begin");
    expect(PUBLIC_EVENT_TYPES).toContain("channel.giveaway.end");
    const keys = Object.keys(EVENTS["channel.giveaway.end"].payload.shape);
    expect(keys.some((k) => /user_id|entrant|pseudonym/.test(k) && k !== "broadcaster_user_id")).toBe(false);
  });
});

describe("internal", () => {
  test("keys, queues, routes and job payloads", () => {
    expect(KEYS.rehearsalModerationSamples(id(1))).toBe(`rehearsal:moderation-samples:${id(1)}`);
    expect(KEYS.roomPresence(id(1))).toBe(`room:presence:${id(1)}`);
    expect(KEYS.roomSync(id(1))).toBe(`room:sync:${id(1)}`);
    expect(new Set(Object.values(QUEUES)).size).toBe(Object.values(QUEUES).length);
    expect(Object.values(FEDERATION_JOBS)).toHaveLength(6);
    expect(INTERNAL_ROUTES.uploadCommit).toBe("/internal/uploads/commit");
    expect(
      UploadCommitBody.safeParse({ channelId: id(1), userId: id(2), key: "incoming/x", purpose: "avatar" }).success,
    ).toBe(false);
    expect(UploadCommitResult.parse({ ok: false, code: "upload_rejected" }).ok).toBe(false);
    expect(B7TickBody.parse({ job: "jury-draw" })).toEqual({ job: "jury-draw", data: {} });
  });
});

describe("api", () => {
  test("new output fields may be absent while their units have not filled them", () => {
    const pred = PredictionView.parse({
      id: id(1),
      title: "t",
      outcomes: [],
      status: "active",
      startedAt: "2026-11-01T10:00:00Z",
      locksAt: "2026-11-01T10:01:00Z",
      lockedAt: null,
      endedAt: null,
      winningOutcomeId: null,
      myBet: null,
    });
    expect([pred.lockMediaTs, pred.resolvedBy, pred.result]).toEqual([undefined, undefined, undefined]);
    expect(PredictionView.safeParse({ ...pred, result: { pool: 10, winners: 2, payoutSum: 10 } }).success).toBe(true);
    expect(
      SurgeState.parse({ state: "off", since: null, until: null, by: null, unavailable: false }).raid,
    ).toBeUndefined();
    expect(Channel.shape.movedTo.parse(null)).toBeNull();
    expect(Channel.shape.movedTo.safeParse({ url: "https://x.test", at: "nope" }).success).toBe(false);
    expect(InstanceInfo.shape.features.shape.giveaways.safeParse(undefined).success).toBe(false);
  });

  test("new inputs", () => {
    const bet = input(contract.interact.predictions.bet).parse({ id: id(1), outcomeId: "a", points: 5 });
    expect(bet).toMatchObject({ mediaTs: null, playbackMode: "live" });
    const follow = input(contract.channels.follow);
    expect(follow.safeParse({ channel: "sam", moveLink: { nonce: "n".repeat(22) } }).success).toBe(true);
    expect(input(contract.me.exports.create).safeParse({ kind: "bundle" }).success).toBe(false);
    const move = input(contract.portability.move.set);
    expect(move.safeParse({ channel: "sam", movedTo: "https://example.test/sam" }).success).toBe(true);
    expect(move.safeParse({ channel: "sam", movedTo: "http://example.test/sam" }).success).toBe(false);
    expect(move.safeParse({ channel: "sam", movedTo: "https://user:pw@example.test/sam" }).success).toBe(false);
    expect(input(contract.relays.purges).parse({ after: "12" })).toEqual({ after: 12 });
  });

  test("the purge feed is a signed envelope over a base64url payload", () => {
    const batch = { seq: 3, items: [{ seq: 3, prefix: `dvr/${id(1)}/`, reason: "vod_hidden" }] };
    const payload = btoa(JSON.stringify(batch)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const feed = { payload, signature: "A".repeat(86) };
    expect(RelayPurgeFeed.safeParse(feed).success).toBe(true);
    expect(RelayPurgeFeed.safeParse({ ...feed, signature: "x" }).success).toBe(false);
    expect(RelayPurgeFeed.safeParse({ ...feed, payload: batch }).success).toBe(false);
    expect(RelayPurgeFeed.safeParse({ ...feed, payload: `${feed.payload}=` }).success).toBe(false);
  });

  test("the purge batch rules", () => {
    const item = (seq: number, prefix = "live/alice/") => ({ seq, prefix, reason: "suspended" });
    expect(RelayPurgeBatch.safeParse({ seq: 3, items: [item(2), item(3)] }).success).toBe(true);
    expect(RelayPurgeBatch.safeParse({ seq: 9, items: [] }).success).toBe(true);
    expect(RelayPurgeBatch.safeParse({ seq: 9, items: [], reset: true }).success).toBe(true);
    for (const bad of [
      { seq: 3, items: [item(3), item(2)] },
      { seq: 4, items: [item(3)] },
      { seq: 3, items: [item(3)], reset: true },
      { seq: 3, items: [], reset: false },
      { seq: 3, items: [item(3, "vod/x/")] },
      { seq: 3, items: [item(3, "live/../x/")] },
      { seq: 3, items: [item(3, "live/alice")] },
      { seq: 3, items: [], extra: 1 },
    ])
      expect(RelayPurgeBatch.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    for (const reason of RELAY_PURGE_REASONS) expect(RELAY_PURGE_REASON.test(reason)).toBe(true);
  });

  test("every batch 7 procedure exists", () => {
    const names = (o: object, prefix = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        typeof v === "object" && v !== null && !("~orpc" in v)
          ? names(v as object, `${prefix}${k}.`)
          : [`${prefix}${k}`],
      );
    const all = new Set(names(contract));
    for (const p of [
      "watchRooms.create",
      "watchRooms.get",
      "watchRooms.invite",
      "watchRooms.join",
      "watchRooms.leave",
      "watchRooms.close",
      "watchRooms.mine",
      "portability.links.list",
      "portability.links.create",
      "portability.links.revoke",
      "portability.links.resolve",
      "portability.grants.set",
      "portability.grants.mine",
      "portability.move.set",
      "portability.move.clear",
      "portability.bundle.create",
      "portability.imports.upload",
      "portability.imports.preview",
      "portability.imports.start",
      "portability.imports.get",
      "portability.imports.list",
      "interact.giveaways.current",
      "interact.giveaways.open",
      "interact.giveaways.enter",
      "interact.giveaways.close",
      "interact.giveaways.draw",
      "interact.giveaways.cancel",
      "interact.giveaways.verify",
      "jury.optIn",
      "jury.optOut",
      "jury.status",
      "jury.panel",
      "jury.cases",
      "jury.vote",
      "jury.results",
      "jury.flags.list",
      "twitchImport.status",
      "twitchImport.connect",
      "twitchImport.preview",
      "twitchImport.start",
      "federation.settings.get",
      "federation.settings.update",
      "federation.followers.list",
      "federation.followers.remove",
      "federation.admin.blocks.list",
      "federation.admin.blocks.add",
      "federation.admin.blocks.remove",
      "federation.admin.keys.rotate",
      "relays.purges",
    ])
      expect(all, p).toContain(p);
  });
});
