// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { DEMO_FIXTURES, isDemoFixtureIdentity } from "@commonair/contracts/fixtures";
import { EMAIL_LIKE, USERNAME_LIKE, demoIdentity, likeEscape } from "../src/demo/anchors.ts";
import { CLEAR_STEPS } from "../src/demo/clear.ts";
import { DemoUsageError, describeTarget, formatClearReport, parseDemoArgs } from "../src/demo/cli.ts";
import {
  DEMO_BOT,
  DEMO_CHAT,
  DEMO_FOLLOWS,
  DEMO_HANDLES,
  DEMO_MODERATION,
  DEMO_MODERATORS,
  DEMO_STREAMERS,
  DEMO_VIEWERS,
} from "../src/demo/data.ts";
import { generatePassword, hashPassword, passwordProblem, verifyPassword } from "../src/demo/password.ts";

describe("anchors", () => {
  test("LIKE patterns escape the prefix's underscore", () => {
    expect(likeEscape("demo_")).toBe("demo\\_");
    expect(likeEscape("a%b\\c")).toBe("a\\%b\\\\c");
    expect(USERNAME_LIKE).toBe("demo\\_%");
    expect(EMAIL_LIKE).toBe(`%@${DEMO_FIXTURES.emailDomain}`);
  });

  test("every demo identity carries both anchors", () => {
    for (const handle of DEMO_HANDLES) {
      const { username, email } = demoIdentity(handle);
      expect(isDemoFixtureIdentity(username, email), handle).toBe(true);
      expect(username).toMatch(/^[a-z0-9_]{3,25}$/);
    }
    expect(demoIdentity("Viewer1")).toEqual({
      username: "demo_viewer1",
      email: "demo_viewer1@demo-seed.invalid",
    });
  });
});

describe("demo content", () => {
  test("3 streamers, 6 viewers, one bot, unique handles", () => {
    expect(DEMO_STREAMERS).toHaveLength(3);
    expect(DEMO_VIEWERS).toHaveLength(6);
    expect(new Set(DEMO_HANDLES).size).toBe(DEMO_HANDLES.length);
    expect(DEMO_HANDLES).toContain(DEMO_BOT.handle);
  });

  test("references only point at known accounts and channels", () => {
    const handles = new Set(DEMO_HANDLES);
    const streamers = new Set(DEMO_STREAMERS.map((s) => s.handle));
    expect(streamers.has(DEMO_BOT.owner)).toBe(true);
    for (const [follower, targets] of Object.entries(DEMO_FOLLOWS)) {
      expect(handles.has(follower), follower).toBe(true);
      for (const t of targets) {
        expect(streamers.has(t), t).toBe(true);
        expect(t, "no self-follows").not.toBe(follower);
      }
    }
    for (const m of DEMO_MODERATORS) {
      expect(streamers.has(m.channel)).toBe(true);
      expect(handles.has(m.user)).toBe(true);
    }
    for (const line of DEMO_CHAT) {
      expect(streamers.has(line.channel), line.channel).toBe(true);
      expect(handles.has(line.author), line.author).toBe(true);
    }
  });

  test("about fifty chat lines on every channel", () => {
    expect(DEMO_CHAT.length).toBeGreaterThanOrEqual(45);
    expect(DEMO_CHAT.length).toBeLessThanOrEqual(60);
    for (const s of DEMO_STREAMERS) expect(DEMO_CHAT.some((l) => l.channel === s.handle)).toBe(true);
    for (const l of DEMO_CHAT) expect(l.body.length).toBeLessThanOrEqual(500);
  });

  test("the timeout is by a moderator of that channel and the ban by the owner", () => {
    const { timeout, ban } = DEMO_MODERATION;
    expect(DEMO_MODERATORS).toContainEqual({ channel: timeout.channel, user: timeout.moderator });
    expect(timeout.durationSeconds).toBeGreaterThan(0);
    expect(ban.moderator).toBe(ban.channel);
    expect(timeout.target).not.toBe(ban.target);
  });

  test("every channel has past broadcasts that ended before now", () => {
    for (const s of DEMO_STREAMERS) {
      expect(s.history.length).toBeGreaterThan(0);
      for (const h of s.history) expect(h.durationMinutes / 60).toBeLessThan(h.startedHoursAgo);
    }
  });
});

describe("password", () => {
  test("better-auth's scrypt format: <32 hex salt>:<128 hex key>", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(await verifyPassword(hash, "correct horse battery")).toBe(true);
    expect(await verifyPassword(hash, "correct horse batterY")).toBe(false);
    expect(await verifyPassword("garbage", "x")).toBe(false);
    // Salted: the same password hashes differently.
    expect(await hashPassword("correct horse battery")).not.toBe(hash);
  });

  test("NFKC-normalized like better-auth", async () => {
    const hash = await hashPassword("ﬁancé-password");
    expect(await verifyPassword(hash, "fiancé-password")).toBe(true);
  });

  test("generated passwords are strong and within better-auth's limits", () => {
    const a = generatePassword();
    expect(a).toHaveLength(24);
    expect(passwordProblem(a)).toBeNull();
    expect(generatePassword()).not.toBe(a);
    expect(passwordProblem("short")).toMatch(/at least 10/);
    expect(passwordProblem("x".repeat(257))).toMatch(/at most 256/);
  });
});

describe("clear plan", () => {
  const order = CLEAR_STEPS.map((s) => s.table);
  const expectBefore = (child: string, parent: string) => {
    expect(order.indexOf(child), child).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(parent), parent).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(child), `${child} before ${parent}`).toBeLessThan(order.indexOf(parent));
  };

  test("children before RESTRICT parents", () => {
    for (const child of ["playback_sessions", "stream_hours"]) expectBefore(child, "broadcasts");
    for (const child of ["playback_sessions", "stream_hours", "integrity_flags", "reports", "broadcasts"])
      expectBefore(child, "channels");
    for (const child of ["chat_messages", "chat_bans", "follows", "channel_roles", "stream_keys", "mod_actions"])
      expectBefore(child, "channels");
    expectBefore("channels", "users");
    expectBefore("channels", "users (bots)");
    expectBefore("users (bots)", "users");
    for (const child of ["sessions", "accounts", "oauth_tokens", "notifications"]) expectBefore(child, "users (bots)");
  });

  test("never touches append-only, money, co-op or relay tables", () => {
    const forbidden =
      /audit_log|ledger|governance|vote|membership|proposal|subscription|tip|payment|payout|relay|election|council|patronage/;
    for (const t of order) expect(t).not.toMatch(forbidden);
  });
});

describe("cli", () => {
  test("parses commands and refuses unknown options", () => {
    expect(parseDemoArgs(["seed"])).toEqual({ kind: "seed", reset: false });
    expect(parseDemoArgs(["seed", "--reset"])).toEqual({ kind: "seed", reset: true });
    expect(parseDemoArgs(["clear"])).toEqual({ kind: "clear", execute: false });
    expect(parseDemoArgs(["clear", "--yes"])).toEqual({ kind: "clear", execute: true });
    expect(parseDemoArgs([])).toEqual({ kind: "help" });
    expect(() => parseDemoArgs(["clear", "--force"])).toThrow(DemoUsageError);
    expect(() => parseDemoArgs(["seed", "--yes"])).toThrow(DemoUsageError);
    expect(() => parseDemoArgs(["wipe"])).toThrow(DemoUsageError);
  });

  test("the target description never includes credentials", () => {
    expect(describeTarget("postgres://commonair:s3cret@db.example.org:5432/commonair")).toBe(
      "db.example.org:5432/commonair",
    );
    expect(describeTarget("postgres://u:p@localhost/x")).toBe("localhost/x");
  });

  test("the report says whether it was a dry run", () => {
    const report = { anchoredUsers: 2, steps: [{ table: "users", what: "demo users", rows: 2 }] };
    expect(formatClearReport(report, false)).toContain("Dry run: would delete 2 row(s)");
    expect(formatClearReport(report, true)).toContain("Deleted 2 row(s)");
  });
});
