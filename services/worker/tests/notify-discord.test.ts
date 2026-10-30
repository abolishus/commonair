// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The Discord adapter's pure parts (ADR 0028 decision 5): the message, the answer mapping, retry-after. */
import { describe, expect, test } from "vite-plus/test";
import { job } from "../src/jobs/notify-discord.ts";
import { productionTransport, reenqueueId } from "../src/notify/discord/job.ts";
import { classifyDiscordResult, MAX_RETRY_AFTER_MS, retryAfterMs } from "../src/notify/discord/outcome.ts";
import { postDiscord } from "../src/notify/discord/post.ts";
import { cut, DISCORD_CONTENT_MAX, goLiveMessage, testMessage } from "../src/notify/discord/text.ts";
import type { PostResult } from "../src/webhooks/http.ts";

const URL_ = "https://air.example/neon";

describe("goLiveMessage", () => {
  test("names the channel, the title and the link, and disables every mention", () => {
    expect(goLiveMessage({ channel: "Neon", title: "Late night synths", url: URL_, mature: false })).toEqual({
      content: `Neon is live: Late night synths ${URL_}`,
      allowed_mentions: { parse: [] },
    });
  });

  test("a mature broadcast or channel posts no title", () => {
    const m = goLiveMessage({ channel: "Neon", title: "Something explicit", url: URL_, mature: true });
    expect(m.content).toBe(`Neon is live (18+) ${URL_}`);
    expect(m.content).not.toContain("explicit");
    expect(m.allowed_mentions).toEqual({ parse: [] });
  });

  test("an empty title posts the short form without the 18+ label", () => {
    expect(goLiveMessage({ channel: "Neon", title: "  ", url: URL_, mature: false }).content).toBe(
      `Neon is live ${URL_}`,
    );
  });

  test("@everyone, @here and role mentions in a title stay text (mentions are off)", () => {
    const m = goLiveMessage({ channel: "Neon", title: "@everyone @here <@&123> <@456>", url: URL_, mature: false });
    expect(m.content).toContain("@everyone @here <@&123> <@456>");
    expect(m.allowed_mentions.parse).toEqual([]);
    expect(Object.keys(m)).toEqual(["content", "allowed_mentions"]);
  });

  test("a long title is cut at Discord's 2000 characters and the link survives", () => {
    const m = goLiveMessage({ channel: "Neon", title: "x".repeat(5000), url: URL_, mature: false });
    expect(m.content.length).toBe(DISCORD_CONTENT_MAX);
    expect(m.content.endsWith(`… ${URL_}`)).toBe(true);
  });

  test("a very long channel name is cut too, leaving room for the title and link", () => {
    const m = goLiveMessage({ channel: "N".repeat(3000), title: "t".repeat(3000), url: URL_, mature: false });
    expect(m.content.length).toBeLessThanOrEqual(DISCORD_CONTENT_MAX);
    expect(m.content.endsWith(URL_)).toBe(true);
    expect(m.content).toContain(" is live: ");
    const mature = goLiveMessage({ channel: "N".repeat(3000), title: "", url: URL_, mature: true });
    expect(mature.content.length).toBeLessThanOrEqual(DISCORD_CONTENT_MAX);
    expect(mature.content.endsWith(`(18+) ${URL_}`)).toBe(true);
  });

  test("placeholders in a title are not expanded", () => {
    expect(goLiveMessage({ channel: "Neon", title: "{url} {channel}", url: URL_, mature: false }).content).toBe(
      `Neon is live: {url} {channel} ${URL_}`,
    );
  });
});

describe("cut", () => {
  test("keeps short text, cuts long text with an ellipsis, never splits a surrogate pair", () => {
    expect(cut("abc", 3)).toBe("abc");
    expect(cut("abcd", 3)).toBe("ab…");
    expect(cut("abc", 0)).toBe("");
    const emoji = "😀😀😀";
    const c = cut(emoji, 4);
    expect(c).toBe("😀…");
    expect(c.length).toBeLessThanOrEqual(4);
  });
});

test("testMessage names the instance and the channel, with mentions off", () => {
  expect(testMessage({ instance: "Air", channel: "Neon" })).toEqual({
    content: "Test from Air: go-live posts for Neon will appear here.",
    allowed_mentions: { parse: [] },
  });
});

const ok = (status: number, body = "", headers: Record<string, string> = {}): PostResult => ({
  ok: true,
  status,
  body,
  headers,
  latencyMs: 1,
  truncated: false,
});
const fail = (error: string, rejected: boolean): PostResult => ({ ok: false, error, rejected, latencyMs: 1 });

describe("classifyDiscordResult", () => {
  test.each([
    [ok(204), { kind: "posted" }],
    [ok(200), { kind: "posted" }],
    [ok(401), { kind: "gone", error: "unauthorized" }],
    [ok(404), { kind: "gone", error: "not_found" }],
    [ok(400), { kind: "rejected" }],
    [ok(403), { kind: "rejected" }],
    [ok(413), { kind: "rejected" }],
    [ok(301), { kind: "rejected" }],
    [ok(500), { kind: "network" }],
    [ok(503), { kind: "network" }],
    [fail("timeout after 10000 ms", false), { kind: "network" }],
    [fail("ECONNRESET: socket hang up", false), { kind: "network" }],
    [fail("host does not resolve", true), { kind: "network" }],
    [fail("callback resolution failed", true), { kind: "network" }],
    [fail("address is loopback", true), { kind: "blocked" }],
    [fail("scheme must be https", true), { kind: "blocked" }],
  ] as const)("%j → %j", (result, expected) => {
    expect(classifyDiscordResult(result)).toEqual(expected);
  });

  test("429 carries Discord's wait", () => {
    expect(classifyDiscordResult(ok(429, JSON.stringify({ retry_after: 1.5, global: false })))).toEqual({
      kind: "rate_limited",
      retryAfterMs: 1500,
    });
    expect(classifyDiscordResult(ok(429))).toEqual({ kind: "rate_limited", retryAfterMs: null });
  });
});

describe("retryAfterMs", () => {
  test("the body's retry_after (fractional seconds) wins over the header", () => {
    expect(retryAfterMs(JSON.stringify({ retry_after: 0.25 }), { "retry-after": "9" })).toBe(250);
    expect(retryAfterMs(JSON.stringify({ retry_after: "2" }), {})).toBe(2000);
  });
  test("falls back to the header: seconds or an HTTP date", () => {
    expect(retryAfterMs("", { "retry-after": "3" })).toBe(3000);
    expect(retryAfterMs("<html>", { "retry-after": " 1.2 " })).toBe(1200);
    const now = Date.parse("2026-10-30T12:00:00Z");
    expect(retryAfterMs("", { "retry-after": "Fri, 30 Oct 2026 12:00:30 GMT" }, now)).toBe(30_000);
    expect(retryAfterMs("", { "retry-after": "Fri, 30 Oct 2026 11:00:00 GMT" }, now)).toBe(0);
  });
  test("nothing usable → null", () => {
    expect(retryAfterMs("", {})).toBeNull();
    expect(retryAfterMs("{}", { "retry-after": "soon" })).toBeNull();
    expect(retryAfterMs(JSON.stringify({ retry_after: -1 }), {})).toBeNull();
    expect(retryAfterMs(JSON.stringify({ retry_after: null }), {})).toBeNull();
  });
  test("an absurd wait is capped", () => {
    expect(retryAfterMs(JSON.stringify({ retry_after: 1e9 }), {})).toBe(MAX_RETRY_AFTER_MS);
  });
});

describe("reenqueueId", () => {
  const data = { channelId: "c", eventId: "e", broadcastId: "b", test: false };
  test("adds -retry-1, then counts up from the current id", () => {
    expect(reenqueueId("discord-e", data)).toEqual({ id: "discord-e-retry-1", n: 1 });
    expect(reenqueueId("discord-e-retry-1", data)).toEqual({ id: "discord-e-retry-2", n: 2 });
    expect(reenqueueId("discord-test-c-123-retry-3", { ...data, test: true })).toEqual({
      id: "discord-test-c-123-retry-4",
      n: 4,
    });
  });
  test("without a job id, the go-live or test base", () => {
    expect(reenqueueId(undefined, data)).toEqual({ id: "discord-e-retry-1", n: 1 });
    expect(reenqueueId(undefined, { ...data, eventId: null, test: true })).toEqual({
      id: "discord-test-c-retry-1",
      n: 1,
    });
  });
});

describe("the registered job", () => {
  test("uses the contract's queue, name, attempts and backoff", () => {
    expect(job.queue).toBe("notifications");
    expect(job.name).toBe("discord");
    expect(job.attempts).toBe(5);
    expect(job.backoffMs).toBe(60_000);
  });
  test("always posts through the full SSRF guard", () => {
    const resolve = async () => [{ address: "127.0.0.1", family: 4 as const }];
    expect(productionTransport({ webhooks: { resolve } as never })).toEqual({ allowInsecure: false, resolve });
  });
});

test("a URL that is not a Discord webhook is blocked without a connection", async () => {
  let resolved = 0;
  const transport = {
    allowInsecure: true,
    resolve: async () => {
      resolved++;
      return [{ address: "127.0.0.1", family: 4 as const }];
    },
  };
  const msg = testMessage({ instance: "Air", channel: "Neon" });
  for (const url of [
    "https://evil.example/api/webhooks/1/abc",
    "http://discord.com/api/webhooks/1/abc",
    "https://discord.com.evil.example/api/webhooks/1/abc",
    "https://discord.com/api/webhooks/1/abc?x=1",
  ])
    expect(await postDiscord(url, msg, transport)).toEqual({ kind: "blocked" });
  expect(resolved).toBe(0);
});
