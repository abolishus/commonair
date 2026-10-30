// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** W1 contract step: data mode, the gate settings, wave reports, chat frames, internal keys, the dm claim. */
import type { z } from "zod";
import { describe, expect, test } from "vite-plus/test";
import { Heartbeat } from "../src/api/entities.ts";
import { contract } from "../src/api/router.ts";
import { ChatControlMessage, ClientFrame, ServerFrame } from "../src/chat.ts";
import { DATA_MODE, dataModeCeilingBps, PROCESSOR_FEE_ESTIMATE, REPORT_SUBJECTS } from "../src/enums.ts";
import { KEYS, OPS_TICK_JOBS, SurgeOverride, VerifiedWatchValue } from "../src/internal.ts";
import { ChannelChatSettings } from "../src/shapes.ts";
import { PlaybackClaims } from "../src/tokens.ts";

const id = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;

describe("data mode (ADR 0018)", () => {
  test("presets map to ceilings inside the claim bounds", () => {
    expect(DATA_MODE.presetsMbPerHour.map(dataModeCeilingBps)).toEqual([96_618, 1_545_894, 3_671_498]);
    expect(dataModeCeilingBps(DATA_MODE.minMbPerHour)).toBeGreaterThanOrEqual(DATA_MODE.minCeilingBps);
    expect(dataModeCeilingBps(DATA_MODE.maxMbPerHour)).toBeLessThanOrEqual(DATA_MODE.maxCeilingBps);
  });

  test("clamps to the claim's bounds", () => {
    expect(dataModeCeilingBps(0)).toBe(DATA_MODE.minCeilingBps);
    expect(dataModeCeilingBps(1_000_000)).toBe(DATA_MODE.maxCeilingBps);
  });

  test("the heartbeat accepts a ceiling, null or nothing, and refuses one out of bounds", () => {
    const beat = {
      sessionId: id(1),
      token: "t",
      playedSeconds: 10,
      bufferSeconds: 2,
      stalls: 0,
      bytesHttp: 0,
      bytesP2p: 0,
      rendition: "source",
      latencySeconds: null,
      ttffMs: null,
      visible: true,
      muted: false,
    };
    expect(Heartbeat.safeParse(beat).success).toBe(true);
    expect(Heartbeat.safeParse({ ...beat, dataMode: null, playbackMode: "dvr", behindLiveSeconds: 30 }).success).toBe(
      true,
    );
    expect(Heartbeat.safeParse({ ...beat, dataMode: 1000 }).success).toBe(false);
  });

  test("the dm claim rides only on origin tokens for a live path", () => {
    const base = { v: 1, sid: id(1), cid: id(2), path: "live/a", src: "origin", iat: 1, exp: 2 } as const;
    expect(PlaybackClaims.safeParse({ ...base, dm: 111_111 }).success).toBe(true);
    expect(PlaybackClaims.safeParse({ ...base, path: "vod/x", dm: 111_111 }).success).toBe(false);
    expect(PlaybackClaims.safeParse({ ...base, src: "relay", rid: id(3), dm: 111_111 }).success).toBe(false);
    expect(PlaybackClaims.safeParse({ ...base, dm: 31_999 }).success).toBe(false);
  });
});

describe("chat settings (ADR 0015)", () => {
  test("new fields default off", () => {
    const s = ChannelChatSettings.parse({});
    expect(s.minVerifiedWatchSeconds).toBe(0);
    expect(s.verifiedWatchExemptSubscribers).toBe(true);
    expect(s.surgeGuard).toEqual({ enabled: false, triggerUnverifiedRatio: 0.5, cooldownMinutes: 10 });
  });

  test.each([
    [0, true],
    [59, false],
    [60, true],
    [3600, true],
    [3601, false],
  ])("minVerifiedWatchSeconds %i is %s", (s, ok) => {
    expect(ChannelChatSettings.safeParse({ minVerifiedWatchSeconds: s }).success).toBe(ok);
  });
});

describe("message_set reports", () => {
  const input = contract.safety.report["~orpc"].inputSchema as z.ZodType;
  const base = { subjectId: id(1), reason: "spam" };

  test("message_set is a report subject", () => {
    expect(REPORT_SUBJECTS).toContain("message_set");
  });

  test("messageIds is required exactly for message_set and contains the subject", () => {
    expect(input.safeParse({ ...base, subjectType: "message_set", messageIds: [id(1), id(2)] }).success).toBe(true);
    expect(input.safeParse({ ...base, subjectType: "message_set" }).success).toBe(false);
    expect(input.safeParse({ ...base, subjectType: "message_set", messageIds: [id(2), id(3)] }).success).toBe(false);
    expect(input.safeParse({ ...base, subjectType: "message_set", messageIds: [id(1)] }).success).toBe(false);
    expect(input.safeParse({ ...base, subjectType: "chat_message", messageIds: [id(1), id(2)] }).success).toBe(false);
    expect(input.safeParse({ ...base, subjectType: "chat_message" }).success).toBe(true);
  });
});

describe("chat frames", () => {
  test("send carries the media-time hint and the playback mode", () => {
    const f = ClientFrame.parse({
      op: "send",
      channel: "alice",
      body: "hi",
      mediaTs: "2026-10-30T12:00:00.000Z",
      playbackMode: "live",
    });
    expect(f.op === "send" && f.mediaTs).toBe("2026-10-30T12:00:00.000Z");
    expect(ClientFrame.safeParse({ op: "send", channel: "alice", body: "hi", mediaTs: "noon" }).success).toBe(false);
  });

  test("surge is a control frame and joined carries the surge state", () => {
    const surge = { op: "surge", channel: "alice", state: "on", until: "2026-10-30T12:10:00.000Z" };
    expect(ChatControlMessage.safeParse(surge).success).toBe(true);
    const joined = {
      op: "joined",
      channel: "alice",
      channelId: id(1),
      settings: ChannelChatSettings.parse({}),
      me: { badges: [], canModerate: false, canChat: true },
    };
    expect(ServerFrame.safeParse(joined).success).toBe(false);
    expect(ServerFrame.safeParse({ ...joined, surge: { state: "off", until: null } }).success).toBe(true);
  });
});

describe("internal", () => {
  test("keys and values", () => {
    expect(KEYS.verifiedWatch("c", "u")).toBe("verified-watch:c:u");
    expect(KEYS.surgeOverride("c")).toBe("surge-override:c");
    expect(KEYS.chatLatency("c")).toBe("chat-latency:c");
    expect(VerifiedWatchValue.safeParse({ b: id(1), s: 120, f: 0 }).success).toBe(true);
    expect(VerifiedWatchValue.safeParse({ b: id(1), s: 120, f: 2 }).success).toBe(false);
    expect(SurgeOverride.safeParse({ state: "on", since: "a", until: "b", by: null }).success).toBe(true);
    expect(SurgeOverride.safeParse({ state: "off", since: "a", until: "b", by: null }).success).toBe(false);
  });

  test("the W1 jobs run through the ops hook", () => {
    expect(OPS_TICK_JOBS).toEqual(
      expect.arrayContaining(["chat-retention", "chat-surge-guard", "money-fraud-scan", "money-reconcile"]),
    );
  });

  test("stripe has a fee estimate, manual none", () => {
    expect(PROCESSOR_FEE_ESTIMATE.manual).toBeNull();
    expect(PROCESSOR_FEE_ESTIMATE.stripe.lowBps).toBeLessThan(PROCESSOR_FEE_ESTIMATE.stripe.highBps);
  });
});
