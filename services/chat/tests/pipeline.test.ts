// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { CHAT_LIMITS, type NoticeCode } from "@commonair/contracts";
import { MemoryLimiter } from "../src/limiter.ts";
import { ALL_CHANNELS, rateLimitFor } from "../src/rules.ts";
import { type MessageMiddleware, runSendPipeline } from "../src/pipeline.ts";
import { channel, deps, input, NOW, standing, user } from "./fixtures.ts";

const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const later = (ms: number) => new Date(NOW.getTime() + ms);

interface Case {
  name: string;
  input: NonNullable<Parameters<typeof input>[0]>;
  expect: NoticeCode | "ok" | "held";
}

const mod = standing({ isModerator: true });
const vip = standing({ isVip: true });
const owner = standing({ isBroadcaster: true });

const cases: Case[] = [
  // auth
  { name: "anonymous", input: { user: null, scopes: [] }, expect: "msg_requires_login" },
  { name: "missing chat:edit", input: { scopes: ["chat:read"] }, expect: "msg_requires_login" },
  // platform ban / suspension
  { name: "platform ban (permanent)", input: { user: user({ banned: true }) }, expect: "msg_banned" },
  {
    name: "platform ban (expiring later)",
    input: { user: user({ banned: true, banExpires: later(DAY) }) },
    expect: "msg_banned",
  },
  { name: "platform ban expired", input: { user: user({ banned: true, banExpires: ago(1) }) }, expect: "ok" },
  { name: "deleted account", input: { user: user({ deleted: true }) }, expect: "msg_banned" },
  // channel suspended
  { name: "channel suspended", input: { channel: channel({}, { suspended: true }) }, expect: "msg_channel_suspended" },
  {
    name: "suspension beats channel ban",
    input: { channel: channel({}, { suspended: true }), standing: standing({ ban: { expiresAt: null, reason: "" } }) },
    expect: "msg_channel_suspended",
  },
  // channel ban / timeout
  {
    name: "channel ban",
    input: { standing: standing({ ban: { expiresAt: null, reason: "x" } }) },
    expect: "msg_banned",
  },
  {
    name: "active timeout",
    input: { standing: standing({ ban: { expiresAt: later(60_000), reason: "" } }) },
    expect: "msg_timedout",
  },
  { name: "expired timeout", input: { standing: standing({ ban: { expiresAt: ago(1), reason: "" } }) }, expect: "ok" },
  // verified email
  {
    name: "unverified email",
    input: { channel: channel({ requireVerifiedEmail: true }), user: user({ emailVerified: false }) },
    expect: "msg_verified_email",
  },
  { name: "unverified email, gate off", input: { user: user({ emailVerified: false }) }, expect: "ok" },
  {
    name: "unverified moderator exempt",
    input: { channel: channel({ requireVerifiedEmail: true }), user: user({ emailVerified: false }), standing: mod },
    expect: "ok",
  },
  {
    name: "unverified bot exempt",
    input: {
      channel: channel({ requireVerifiedEmail: true }),
      user: user({ emailVerified: false, accountType: "bot" }),
    },
    expect: "ok",
  },
  // account age
  {
    name: "account too new",
    input: { channel: channel({ minAccountAgeDays: 7 }), user: user({ createdAt: ago(6 * DAY) }) },
    expect: "msg_account_too_new",
  },
  {
    name: "account exactly old enough",
    input: { channel: channel({ minAccountAgeDays: 7 }), user: user({ createdAt: ago(7 * DAY) }) },
    expect: "ok",
  },
  {
    name: "new account, broadcaster exempt",
    input: { channel: channel({ minAccountAgeDays: 7 }), user: user({ createdAt: ago(0) }), standing: owner },
    expect: "ok",
  },
  // followers-only
  {
    name: "followers-only, not following",
    input: { channel: channel({ followersOnlyMinutes: 0 }) },
    expect: "msg_followersonly",
  },
  {
    name: "followers-only 0, just followed",
    input: { channel: channel({ followersOnlyMinutes: 0 }), standing: standing({ followedAt: NOW }) },
    expect: "ok",
  },
  {
    name: "followers-only 10m, followed 5m ago",
    input: { channel: channel({ followersOnlyMinutes: 10 }), standing: standing({ followedAt: ago(5 * 60_000) }) },
    expect: "msg_followersonly",
  },
  {
    name: "followers-only 10m, followed 10m ago",
    input: { channel: channel({ followersOnlyMinutes: 10 }), standing: standing({ followedAt: ago(10 * 60_000) }) },
    expect: "ok",
  },
  {
    name: "followers-only, vip exempt",
    input: { channel: channel({ followersOnlyMinutes: 10 }), standing: vip },
    expect: "ok",
  },
  // subscribers-only
  { name: "subs-only, not subscribed", input: { channel: channel({ subscribersOnly: true }) }, expect: "msg_subsonly" },
  {
    name: "subs-only, subscriber",
    input: { channel: channel({ subscribersOnly: true }), standing: standing({ subscriberTier: 1 }) },
    expect: "ok",
  },
  { name: "subs-only, vip", input: { channel: channel({ subscribersOnly: true }), standing: vip }, expect: "ok" },
  { name: "subs-only, moderator", input: { channel: channel({ subscribersOnly: true }), standing: mod }, expect: "ok" },
  // emote-only
  {
    name: "emote-only, text",
    input: { channel: channel({ emoteOnly: true }), body: "hi Kappa" },
    expect: "msg_emoteonly",
  },
  { name: "emote-only, emotes", input: { channel: channel({ emoteOnly: true }), body: "Kappa  Kappa" }, expect: "ok" },
  {
    name: "emote-only, locked tier emote",
    input: { channel: channel({ emoteOnly: true }), body: "SubHype", standing: standing({ subscriberTier: 1 }) },
    expect: "msg_emoteonly",
  },
  {
    name: "emote-only, tier emote with tier",
    input: { channel: channel({ emoteOnly: true }), body: "SubHype", standing: standing({ subscriberTier: 2 }) },
    expect: "ok",
  },
  {
    name: "emote-only, moderator text",
    input: { channel: channel({ emoteOnly: true }), body: "hello", standing: mod },
    expect: "ok",
  },
  // links
  {
    name: "links blocked",
    input: { channel: channel({ linksAllowed: false }), body: "see example.com" },
    expect: "msg_links_blocked",
  },
  {
    name: "links blocked, scheme",
    input: { channel: channel({ linksAllowed: false }), body: "https://x.test/a" },
    expect: "msg_links_blocked",
  },
  {
    name: "links blocked, no link",
    input: { channel: channel({ linksAllowed: false }), body: "e.g. 1.5 times" },
    expect: "ok",
  },
  {
    name: "links blocked, mod exempt",
    input: { channel: channel({ linksAllowed: false }), body: "example.com", standing: mod },
    expect: "ok",
  },
  { name: "links allowed", input: { body: "example.com" }, expect: "ok" },
  // word filters
  {
    name: "block filter",
    input: {
      body: "you are a Badword",
      filterDefs: [{ id: "f1", pattern: "badword", isRegex: false, action: "block", replacement: null }],
    },
    expect: "msg_rejected",
  },
  {
    name: "hold filter",
    input: {
      body: "maybe sus",
      filterDefs: [{ id: "f2", pattern: "s.s", isRegex: true, action: "hold", replacement: null }],
    },
    expect: "held",
  },
  {
    name: "filters skip moderators",
    input: {
      body: "badword",
      standing: mod,
      filterDefs: [{ id: "f1", pattern: "badword", isRegex: false, action: "block", replacement: null }],
    },
    expect: "ok",
  },
  {
    name: "block beats hold",
    input: {
      body: "bad sus",
      filterDefs: [
        { id: "h", pattern: "sus", isRegex: false, action: "hold", replacement: null },
        { id: "b", pattern: "bad", isRegex: false, action: "block", replacement: null },
      ],
    },
    expect: "msg_rejected",
  },
];

describe("send pipeline rules", () => {
  test.each(cases)("$name → $expect", async (c) => {
    const r = await runSendPipeline(deps(), input(c.input));
    const outcome = r.ok ? (r.held ? "held" : "ok") : r.rejection.code;
    expect(outcome).toBe(c.expect);
  });
});

describe("stateful rules", () => {
  test("slow mode blocks a second message and exempts VIPs and moderators", async () => {
    let now = NOW.getTime();
    const limiter = new MemoryLimiter(() => now);
    const ch = channel({ slowModeSeconds: 30 });
    const send = (body: string, st = standing()) =>
      runSendPipeline(deps([], limiter), input({ channel: ch, body, standing: st, receivedAt: new Date(now) }));
    expect((await send("one")).ok).toBe(true);
    const second = await send("two");
    expect(second.ok ? null : second.rejection.code).toBe("msg_slowmode");
    expect((await send("vip one", vip)).ok).toBe(true);
    now += 29_000;
    expect((await send("three")).ok).toBe(false);
    now += 1_001;
    expect((await send("four")).ok).toBe(true);
  });

  test("a rejected message does not start a slow-mode wait", async () => {
    const limiter = new MemoryLimiter(() => NOW.getTime());
    const ch = channel({ slowModeSeconds: 30, linksAllowed: false });
    const blocked = await runSendPipeline(deps([], limiter), input({ channel: ch, body: "example.com" }));
    expect(blocked.ok).toBe(false);
    expect((await runSendPipeline(deps([], limiter), input({ channel: ch, body: "fine" }))).ok).toBe(true);
  });

  test("rate limit: users get CHAT_LIMITS.user per window, moderators more, bots the bot limit", async () => {
    const run = async (st = standing(), u = user()) => {
      const limiter = new MemoryLimiter(() => NOW.getTime());
      const outcomes = new Set<string>();
      let accepted = 0;
      for (let i = 0; i < 120; i++) {
        const r = await runSendPipeline(deps([], limiter), input({ body: `m${i}`, standing: st, user: u }));
        accepted += r.ok ? 1 : 0;
        outcomes.add(r.ok ? "ok" : r.rejection.code);
      }
      expect([...outcomes]).toEqual(["ok", "msg_ratelimit"]);
      return accepted;
    };
    expect(await run()).toBe(CHAT_LIMITS.user);
    expect(await run(mod)).toBe(CHAT_LIMITS.moderator);
    expect(await run(standing(), user({ accountType: "bot" }))).toBe(CHAT_LIMITS.bot);
  });

  test("rate-limit window slides", async () => {
    let now = NOW.getTime();
    const limiter = new MemoryLimiter(() => now);
    for (let i = 0; i < CHAT_LIMITS.user; i++)
      expect((await runSendPipeline(deps([], limiter), input({ body: `m${i}`, receivedAt: new Date(now) }))).ok).toBe(
        true,
      );
    expect((await runSendPipeline(deps([], limiter), input({ body: "x", receivedAt: new Date(now) }))).ok).toBe(false);
    now += CHAT_LIMITS.windowMs + 1;
    expect((await runSendPipeline(deps([], limiter), input({ body: "y", receivedAt: new Date(now) }))).ok).toBe(true);
  });

  test("duplicates are rejected within the window only, per exact body", async () => {
    let now = NOW.getTime();
    const limiter = new MemoryLimiter(() => now);
    const send = (body: string) => runSendPipeline(deps([], limiter), input({ body, receivedAt: new Date(now) }));
    expect((await send("same")).ok).toBe(true);
    const dup = await send("same");
    expect(dup.ok ? null : dup.rejection.code).toBe("msg_duplicate");
    expect((await send("Same")).ok).toBe(true);
    now += CHAT_LIMITS.duplicateWindowMs + 1;
    expect((await send("same")).ok).toBe(true);
  });

  test("ordering: a timed-out user in slow mode gets msg_timedout, not msg_slowmode", async () => {
    const r = await runSendPipeline(
      deps(),
      input({
        channel: channel({ slowModeSeconds: 30 }),
        standing: standing({ ban: { expiresAt: later(1000), reason: "" } }),
      }),
    );
    expect(r.ok ? null : r.rejection.code).toBe("msg_timedout");
  });
});

describe("filters and middleware", () => {
  test("replace filters mask the match", async () => {
    const r = await runSendPipeline(
      deps(),
      input({
        body: "darn it darn",
        filterDefs: [{ id: "r", pattern: "darn", isRegex: false, action: "replace", replacement: null }],
      }),
    );
    expect(r.ok && r.body).toBe("**** it ****");
    const r2 = await runSendPipeline(
      deps(),
      input({
        body: "darn it",
        filterDefs: [{ id: "r", pattern: "darn", isRegex: false, action: "replace", replacement: "heck" }],
      }),
    );
    expect(r2.ok && r2.body).toBe("heck it");
  });

  test("middlewares run in order and can transform or drop", async () => {
    const seen: string[] = [];
    const upper: MessageMiddleware = {
      name: "upper",
      async process(ctx) {
        seen.push(`upper:${ctx.body}`);
        return { transform: `${ctx.body.toUpperCase()} Kappa` };
      },
    };
    const dropper: MessageMiddleware = {
      name: "dropper",
      async process(ctx) {
        seen.push(`dropper:${ctx.body}`);
        return ctx.body.includes("STOP") ? { drop: "msg_rejected", text: "nope" } : "continue";
      },
    };
    const ok = await runSendPipeline(deps([upper, dropper]), input({ body: "hi" }));
    expect(ok.ok && ok.body).toBe("HI Kappa");
    // Emotes are re-parsed after a transform.
    expect(ok.ok && ok.emotes).toEqual([{ emoteId: "e-Kappa", code: "Kappa", start: 3, end: 8 }]);
    expect(seen).toEqual(["upper:hi", "dropper:HI Kappa"]);
    const dropped = await runSendPipeline(deps([upper, dropper]), input({ body: "stop" }));
    expect(dropped.ok ? null : dropped.rejection).toEqual({ code: "msg_rejected", text: "nope" });
  });

  test("a throwing middleware is skipped, not fatal", async () => {
    const broken: MessageMiddleware = {
      name: "broken",
      async process() {
        throw new Error("boom");
      },
    };
    expect((await runSendPipeline(deps([broken]), input())).ok).toBe(true);
  });

  test("a transform to empty text is rejected", async () => {
    const blank: MessageMiddleware = { name: "blank", process: async () => ({ transform: "   " }) };
    const r = await runSendPipeline(deps([blank]), input());
    expect(r.ok ? null : r.rejection.code).toBe("msg_rejected");
  });

  test("middlewares see held state and are not reached when built-in rules reject", async () => {
    let called = 0;
    const spy: MessageMiddleware = {
      name: "spy",
      async process(ctx) {
        called++;
        expect(ctx.held).toBe(true);
        return "continue";
      },
    };
    await runSendPipeline(deps([spy]), input({ user: null }));
    expect(called).toBe(0);
    await runSendPipeline(
      deps([spy]),
      input({
        body: "hold me",
        filterDefs: [{ id: "h", pattern: "hold", isRegex: false, action: "hold", replacement: null }],
      }),
    );
    expect(called).toBe(1);
  });
});

describe("verified bots", () => {
  test("get CHAT_LIMITS.botVerified shared across channels", async () => {
    const limiter = new MemoryLimiter(() => NOW.getTime());
    const bot = user({ accountType: "bot", botVerified: true });
    let accepted = 0;
    for (let i = 0; i < CHAT_LIMITS.bot + 10; i++) {
      const ch = channel({}, { id: `00000000-0000-7000-8000-0000000000${(i % 3) + 10}` });
      const r = await runSendPipeline(deps([], limiter), input({ body: `m${i}`, user: bot, channel: ch }));
      accepted += r.ok ? 1 : 0;
    }
    expect(accepted).toBe(CHAT_LIMITS.bot + 10);
    expect(rateLimitFor(bot, standing(), "c")).toEqual({ limit: CHAT_LIMITS.botVerified, bucket: ALL_CHANNELS });
    expect(rateLimitFor(user({ accountType: "bot" }), standing(), "c")).toEqual({
      limit: CHAT_LIMITS.bot,
      bucket: "c",
    });
    // The flag means nothing on a human account.
    expect(rateLimitFor(user({ botVerified: true }), standing(), "c")).toEqual({
      limit: CHAT_LIMITS.user,
      bucket: "c",
    });
  });
});
