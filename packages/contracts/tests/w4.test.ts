// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Overhaul wave 4 (D6, D7) contract step: preference types, the new payloads and procedure inputs. */
import type { z } from "zod";
import { describe, expect, test } from "vite-plus/test";
import { AUTH_BASE_PATH, AUTH_ROUTES, SESSIONS_SETTINGS_PATH } from "../src/auth.ts";
import { contract } from "../src/api/router.ts";
import { InstanceInfo, ModerationCase } from "../src/api/entities.ts";
import {
  CHAT_TIMEOUT_SECONDS,
  MESSAGE_SET_RULES,
  NOTIFICATION_TYPES,
  PREFERENCE_MEDIA,
  PREFERENCE_TYPE_NOTIFICATIONS,
  PREFERENCE_TYPES,
  STREAM_SETUP_MARKABLE,
  STREAM_SETUP_STEPS,
  UI_METRIC_STEPS,
  UNSUBSCRIBE_LIST_PREFERENCE,
  UNSUBSCRIBE_LISTS,
} from "../src/enums.ts";
import {
  GoLiveNotificationPayload,
  ModeratorAddedNotificationPayload,
  NOTIFY_DEFAULTS,
  ReportOutcomeNotificationPayload,
} from "../src/notify.ts";

const id = (n: number) => `0192f000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const input = (s: unknown) => s as z.ZodType;

describe("preference types", () => {
  test("each notification type belongs to at most one preference type", () => {
    const seen = PREFERENCE_TYPES.flatMap((t) => PREFERENCE_TYPE_NOTIFICATIONS[t]);
    expect(new Set(seen).size).toBe(seen.length);
    for (const n of seen) expect(NOTIFICATION_TYPES).toContain(n);
  });

  test("a default is on only for a medium the type offers", () => {
    for (const t of PREFERENCE_TYPES)
      for (const [medium, on] of Object.entries(NOTIFY_DEFAULTS[t]))
        if (on) expect(PREFERENCE_MEDIA[t], `${t}.${medium}`).toContain(medium);
    expect(Object.values(NOTIFY_DEFAULTS.digest_weekly).some(Boolean)).toBe(false);
  });

  test("every unsubscribe list but moved turns off an email the type offers", () => {
    for (const list of UNSUBSCRIBE_LISTS) {
      const type = UNSUBSCRIBE_LIST_PREFERENCE[list];
      if (list === "moved") expect(type).toBeNull();
      // The governance list predates its mailer (wave 5); its email-off rows are kept for it.
      else if (list === "governance") expect(type).toBe("governance");
      else expect(type !== null && PREFERENCE_MEDIA[type].includes("email"), list).toBe(true);
    }
  });
});

describe("payloads", () => {
  test("go-live display fields are optional (joined at read time)", () => {
    const base = { channelId: id(1), slug: "streamer1", broadcastId: id(2), title: "Live" };
    expect(GoLiveNotificationPayload.safeParse(base).success).toBe(true);
    expect(GoLiveNotificationPayload.safeParse({ ...base, displayName: "S", avatarUrl: null }).success).toBe(true);
  });

  test("report_outcome and moderator_added carry enums and ids only", () => {
    expect(
      ReportOutcomeNotificationPayload.safeParse({ reportId: id(1), subjectType: "chat_message", outcome: "no_action" })
        .success,
    ).toBe(true);
    expect(
      ReportOutcomeNotificationPayload.safeParse({ reportId: id(1), subjectType: "chat_message", outcome: "banned" }).success,
    ).toBe(false);
    expect(
      ModeratorAddedNotificationPayload.safeParse({ channelId: id(1), slug: "streamer1", role: "vip" }).success,
    ).toBe(false);
  });
});

describe("procedures", () => {
  test("chat.bans.bulk: timeouts only, capped at the wave size", () => {
    const schema = input(contract.chat.bans.bulk["~orpc"].inputSchema);
    const ok = { channel: "streamer1", messageIds: [id(1)], durationSeconds: 600 };
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse({ ...ok, durationSeconds: 1_209_600 }).success).toBe(false);
    expect(schema.safeParse({ ...ok, durationSeconds: undefined }).success).toBe(false);
    const wave = Array.from({ length: MESSAGE_SET_RULES.maxMessages + 1 }, (_, i) => id(i));
    expect(schema.safeParse({ ...ok, messageIds: wave }).success).toBe(false);
    expect(CHAT_TIMEOUT_SECONDS).toEqual([60, 600, 3600, 86_400]);
  });

  test("me.update withdraws the 18+ confirmation but never sets it", () => {
    const schema = input(contract.me.update["~orpc"].inputSchema);
    expect(schema.safeParse({ matureConfirmed: false }).success).toBe(true);
    expect(schema.safeParse({ matureConfirmed: true }).success).toBe(false);
  });

  test("me.notifications filters by type", () => {
    const schema = input(contract.me.notifications["~orpc"].inputSchema);
    expect(schema.safeParse({ types: ["go_live", "vote_open"] }).success).toBe(true);
    expect(schema.safeParse({ types: [] }).success).toBe(false);
    expect(schema.safeParse({ types: ["nope"] }).success).toBe(false);
  });

  test("moderation.assign takes an id or null; transparency.setNote a month", () => {
    const assign = input(contract.moderation.assign["~orpc"].inputSchema);
    expect(assign.safeParse({ id: id(1), assigneeId: null }).success).toBe(true);
    const note = input(contract.transparency.setNote["~orpc"].inputSchema);
    expect(note.safeParse({ month: "2026-10", body: "" }).success).toBe(true);
    expect(note.safeParse({ month: "2026-13", body: "x" }).success).toBe(false);
  });

  test("ModerationCase and InstanceInfo carry the wave 4 fields", () => {
    expect(ModerationCase.shape).toHaveProperty("assignee");
    expect(InstanceInfo.shape.features.shape).toHaveProperty("payouts");
  });
});

describe("setup steps and auth routes", () => {
  test("get_paid is a markable step and a funnel step", () => {
    expect(STREAM_SETUP_STEPS).toContain("get_paid");
    for (const s of STREAM_SETUP_MARKABLE) expect(STREAM_SETUP_STEPS).toContain(s);
    expect(UI_METRIC_STEPS).toContain("get_paid");
  });

  test("every auth route is under the mount and unique", () => {
    const paths = Object.values(AUTH_ROUTES);
    for (const p of paths) expect(p.startsWith(`${AUTH_BASE_PATH}/`)).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
    expect(SESSIONS_SETTINGS_PATH).toBe("/settings/security#sessions");
  });
});
