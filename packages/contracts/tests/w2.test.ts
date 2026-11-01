// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** W2 contract step: DVR token paths and state, settings shapes, appeal and staff-input refinements, internal shapes. */
import type { z } from "zod";
import { describe, expect, test } from "vite-plus/test";
import { Clip, IntegritySummary, ReportCount, Vod } from "../src/api/entities.ts";
import { contract } from "../src/api/router.ts";
import { EXCLUSION_CATEGORIES, PLAYBACK_MODES, SPLIT_BASES } from "../src/enums.ts";
import { EVENTS, isInternalEvent } from "../src/events.ts";
import {
  AnalyticsTickBody,
  BroadcastRollupJob,
  INTERNAL_ROUTES,
  IntegrityAttestationJob,
  KEYS,
  QUEUES,
  SegmentFetch,
} from "../src/internal.ts";
import { SCOPES } from "../src/scopes.ts";
import {
  ChannelCaptionsSettings,
  ChannelCaptionsSettingsPatch,
  ChannelDvrSettings,
  ChannelDvrSettingsPatch,
  PayoutRulesSetting,
} from "../src/shapes.ts";
import { type DvrState, dvrServable, dvrTokenPath, vodCaptionsKey, vodPrefix } from "../src/storage.ts";
import { PlaybackClaims } from "../src/tokens.ts";

const id = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const input = (p: { "~orpc": { inputSchema?: unknown } }) => p["~orpc"].inputSchema as z.ZodType;

describe("DVR (ADR 0016)", () => {
  const claims = { v: 1, sid: id(1), cid: id(2), src: "origin", iat: 1, exp: 2 } as const;

  test("a DVR token path is its own namespace and never carries dm", () => {
    expect(dvrTokenPath(id(3))).toBe(`dvr/${id(3)}`);
    expect(PlaybackClaims.safeParse({ ...claims, path: dvrTokenPath(id(3)) }).success).toBe(true);
    expect(PlaybackClaims.safeParse({ ...claims, path: dvrTokenPath(id(3)), dm: 96_000 }).success).toBe(false);
    expect(PlaybackClaims.safeParse({ ...claims, path: "live/x", dm: 96_000 }).success).toBe(true);
  });

  const ok: DvrState = {
    vodStatus: "recording",
    removedReason: null,
    broadcastLive: true,
    broadcastKind: "live",
    broadcastRestricted: false,
    channelSuspended: false,
    dvrEnabled: true,
    nciiHidden: false,
    dmcaHidden: false,
  };

  test("dvrServable admits exactly a live, unrestricted, recording VOD with DVR on", () => {
    expect(dvrServable(ok)).toBe(true);
    const refusals: Partial<DvrState>[] = [
      { vodStatus: "processing" },
      { vodStatus: "ready" },
      { removedReason: "owner" },
      { broadcastLive: false },
      { broadcastKind: "rehearsal" },
      { broadcastRestricted: true },
      { channelSuspended: true },
      { dvrEnabled: false },
      { nciiHidden: true },
      { dmcaHidden: true },
    ];
    for (const r of refusals) expect(dvrServable({ ...ok, ...r }), JSON.stringify(r)).toBe(false);
  });

  test("segment fetches carry an optional mode", () => {
    const f = { sid: id(1), cid: id(2), src: "origin", kind: "segment", bytes: "10", at: "1" };
    expect(SegmentFetch.parse(f).mode).toBeUndefined();
    for (const mode of PLAYBACK_MODES) expect(SegmentFetch.parse({ ...f, mode }).mode).toBe(mode);
    expect(SegmentFetch.safeParse({ ...f, mode: "vod" }).success).toBe(false);
  });

  test("DVR settings default to on and 30 minutes; the patch has no defaults", () => {
    expect(ChannelDvrSettings.parse({})).toEqual({ enabled: true, windowSeconds: 1800 });
    expect(ChannelDvrSettingsPatch.parse({})).toEqual({});
    expect(ChannelDvrSettingsPatch.safeParse({ windowSeconds: 30 }).success).toBe(false);
  });
});

describe("captions (ADR 0011)", () => {
  test("settings follow the instance default until the channel chooses", () => {
    expect(ChannelCaptionsSettings.parse({})).toEqual({ enabled: null, spokenLanguage: null, maskWords: [] });
    expect(ChannelCaptionsSettingsPatch.parse({ enabled: true })).toEqual({ enabled: true });
    expect(ChannelCaptionsSettings.safeParse({ maskWords: Array(101).fill("x") }).success).toBe(false);
    expect(ChannelCaptionsSettings.safeParse({ spokenLanguage: "not a tag" }).success).toBe(false);
  });

  test("VOD captions live under the VOD's own prefix", () => {
    expect(vodCaptionsKey(vodPrefix(id(4), "private"), "es")).toBe(`recordings/${id(4)}/captions/es.vtt`);
    expect(() => vodCaptionsKey("recordings/x/", "../x")).toThrow(RangeError);
  });

  test("Vod and Clip carry the new required fields", () => {
    expect(Vod.shape.captions).toBeDefined();
    expect(Clip.shape.windowStartedAt.safeParse(null).success).toBe(true);
  });
});

describe("splits (ADR 0013)", () => {
  test("payout rules gain the split fields with their defaults", () => {
    const r = PayoutRulesSetting.parse({ minimumCents: 2500, schedule: "monthly", holdDays: 7, currency: "usd" });
    expect(r).toMatchObject({
      splitShortfallWriteOffDays: 365,
      splitNewRecipientHoldDays: 7,
      splitRecipientMinAccountAgeDays: 30,
    });
  });

  test("propose refuses shares that leave the owner nothing or repeat a recipient", () => {
    const p = input(contract.money.splits.propose);
    const base = { channel: "abc", basis: SPLIT_BASES[0] };
    expect(p.safeParse({ ...base, shares: [{ username: "crew", bps: 2500 }] }).success).toBe(true);
    expect(
      p.safeParse({
        ...base,
        shares: [
          { username: "a_1", bps: 5000 },
          { username: "b_1", bps: 5000 },
        ],
      }).success,
    ).toBe(false);
    expect(
      p.safeParse({
        ...base,
        shares: [
          { username: "crew", bps: 1 },
          { username: "crew", bps: 1 },
        ],
      }).success,
    ).toBe(false);
    expect(p.safeParse({ ...base, shares: [] }).success).toBe(false);
    expect(SCOPES).toHaveProperty("channel:manage:splits");
  });
});

describe("appeals and staff inputs", () => {
  const create = input(contract.appeals.create);
  const body = "a long enough appeal body";

  test("exclusion_group needs a category and kind integrity; other subjects refuse one", () => {
    expect(
      create.safeParse({
        kind: "integrity",
        subjectType: "exclusion_group",
        subjectId: id(1),
        category: "datacenter",
        body,
      }).success,
    ).toBe(true);
    expect(
      create.safeParse({ kind: "integrity", subjectType: "exclusion_group", subjectId: id(1), body }).success,
    ).toBe(false);
    expect(
      create.safeParse({
        kind: "moderation",
        subjectType: "exclusion_group",
        subjectId: id(1),
        category: "datacenter",
        body,
      }).success,
    ).toBe(false);
    expect(
      create.safeParse({ kind: "integrity", subjectType: "session", subjectId: id(1), category: "datacenter", body })
        .success,
    ).toBe(false);
    expect(create.safeParse({ kind: "integrity", subjectType: "session", subjectId: id(1), body }).success).toBe(true);
  });

  test("a platform report action and a suspension cite a clause; lifting and channel bans need none", () => {
    const resolve = input(contract.safety.resolve);
    const r = { id: id(1), status: "actioned", resolution: "done" };
    expect(resolve.safeParse({ ...r, action: "none" }).success).toBe(true);
    expect(resolve.safeParse({ ...r, action: "ban_from_channel" }).success).toBe(true);
    expect(resolve.safeParse({ ...r, action: "suspend_user" }).success).toBe(false);
    expect(resolve.safeParse({ ...r, action: "suspend_user", clauseId: "honesty.spam" }).success).toBe(true);
    expect(resolve.safeParse({ ...r, action: "remove_content", clauseId: "Not A Clause" }).success).toBe(false);
    const suspend = input(contract.safety.suspend);
    const s = { username: "someone", target: "user", reason: "r" };
    expect(suspend.safeParse({ ...s, suspended: true }).success).toBe(false);
    expect(suspend.safeParse({ ...s, suspended: true, clauseId: "decency.harassment" }).success).toBe(true);
    expect(suspend.safeParse({ ...s, suspended: false }).success).toBe(true);
  });
});

describe("analytics, attestations and the enforcement report", () => {
  test("IntegritySummary is integer seconds by category", () => {
    const s = {
      channelSlug: "abc",
      periodStart: "2026-10-01T00:00:00Z",
      periodEnd: "2026-11-01T00:00:00Z",
      verifiedViewerSeconds: 3600,
      unverifiedViewerSeconds: 0,
      excludedViewerSeconds: 60,
      excludedFollows: 0,
      exclusionsByCategory: [{ category: EXCLUSION_CATEGORIES[0], sessions: 5, viewerSeconds: 60 }],
      hiddenGroups: 1,
    };
    expect(IntegritySummary.safeParse(s).success).toBe(true);
    expect(IntegritySummary.safeParse({ ...s, verifiedViewerSeconds: 1.5 }).success).toBe(false);
    expect(
      IntegritySummary.safeParse({
        ...s,
        exclusionsByCategory: [{ category: "datacenter_ip", sessions: 1, viewerSeconds: 1 }],
      }).success,
    ).toBe(false);
  });

  test("a suppressed report cell has no number", () => {
    expect(ReportCount.parse({ suppressed: false, value: 0 })).toEqual({ suppressed: false, value: 0 });
    expect(ReportCount.parse({ suppressed: true, value: 3 })).toEqual({ suppressed: true });
  });

  test("the enforcement window is 30d or a calendar month", () => {
    const w = input(contract.transparency.enforcement);
    expect(w.parse({})).toEqual({ window: "30d" });
    expect(w.safeParse({ window: "2026-10" }).success).toBe(true);
    expect(w.safeParse({ window: "2026-13" }).success).toBe(false);
  });

  test("the well-known key history sits at its fixed path", () => {
    expect(contract.integrity.keys.list["~orpc"].route.path).toBe("/.well-known/commonair-attestation");
  });

  test("verify takes exactly one of an envelope or a bundle", () => {
    const v = input(contract.integrity.attestations.verify);
    const env = { payload: "p", signature: "s" };
    expect(v.safeParse({}).success).toBe(false);
    expect(v.safeParse({ envelope: env, bundle: [env] }).success).toBe(false);
    expect(v.safeParse({ envelope: env }).success).toBe(true);
    expect(v.safeParse({ bundle: [env] }).success).toBe(true);
  });

  test("a compromised kid is a derived kid, and the window bundle is public", () => {
    const c = input(contract.integrity.keys.compromise);
    expect(c.safeParse({ kid: "A".repeat(22), reason: "leak" }).success).toBe(true);
    expect(c.safeParse({ kid: "short", reason: "leak" }).success).toBe(false);
    const b = contract.integrity.attestations.bundle["~orpc"];
    expect(b.meta.access).toBe("public");
    expect(input(contract.integrity.attestations.bundle).parse({ channel: "abc" })).toEqual({
      channel: "abc",
      fromSeq: 1,
      limit: 100,
    });
    for (const p of [
      contract.integrity.attestations.shareLinks.list,
      contract.integrity.attestations.shareLinks.revoke,
    ])
      expect(p["~orpc"].route.path).toMatch(/^\/channels\/\{channel\}\/attestations\/share-links/);
  });
});

describe("internal", () => {
  test("job payloads and the test hook", () => {
    expect(BroadcastRollupJob.safeParse({ broadcastId: id(1), reason: "offline" }).success).toBe(true);
    expect(BroadcastRollupJob.safeParse({ broadcastId: id(1), reason: "manual" }).success).toBe(false);
    expect(IntegrityAttestationJob.safeParse({ broadcastId: id(1), reason: "reconcile" }).success).toBe(true);
    expect(AnalyticsTickBody.parse({ job: "broadcast-rollup", broadcastId: id(1) }).settleSeconds).toBe(0);
    expect(AnalyticsTickBody.safeParse({ job: "attestation-reconcile", broadcastId: id(1) }).success).toBe(false);
    expect(INTERNAL_ROUTES.analyticsTick).toBe("/internal/analytics/tick");
    expect(QUEUES).toMatchObject({ analytics: "analytics", rehearsal: "rehearsal" });
  });

  test("keys", () => {
    expect(KEYS.rehearsalArmed("c")).toBe("rehearsal:armed:c");
    expect(KEYS.rehearsalReport("b")).toBe("rehearsal:report:b");
  });

  test("every W2 event is internal", () => {
    for (const t of [
      "channel.split.update",
      "analytics.rollup.ready",
      "integrity.attestation.appended",
      "integrity.key.compromised",
      "integrity.sessions.rescored",
      "rehearsal.armed",
      "rehearsal.ended",
    ] as const) {
      expect(EVENTS[t]).toBeDefined();
      expect(isInternalEvent(t)).toBe(true);
    }
  });
});
