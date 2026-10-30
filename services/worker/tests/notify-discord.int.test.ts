// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `discord` job against a local HTTPS receiver posing as discord.com (ADR 0028 decision 5): a
 * throwaway CA signs a certificate for discord.com, the transport pins discord.com to 127.0.0.1,
 * and the code's clock is pinned (never the host's against Postgres's).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstanceSite } from "@commonair/config/site";
import { NOTIFY_RULES, NOTIFY_SECRET_PURPOSES } from "@commonair/contracts/notify";
import { schema, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createLogger } from "@commonair/observability";
import { encryptSecret } from "@commonair/tokens";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import type { EnqueueOptions, WorkerContext } from "../src/context.ts";
import { job as discordJobDef } from "../src/jobs/notify-discord.ts";
import { DiscordRetry, runDiscordJob, type DiscordJobCtx } from "../src/notify/discord/job.ts";
import type { DiscordTransport } from "../src/notify/discord/post.ts";
import { clearGoLiveSettingCache, DEFAULT_GO_LIVE_SETTING } from "../src/notify/settings.ts";
import type { Resolver } from "../src/webhooks/ssrf.ts";
import { AUTH_SECRET, makeBroadcast, makeUser } from "./fixtures.ts";

const { discordWebhooks: hooks } = schema;
const HOUR = 3_600_000;

// --- a TLS receiver for discord.com -----------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "worker-discord-tls-"));
const openssl = (...args: string[]) => {
  const r = Bun.spawnSync(["openssl", ...args], { cwd: dir, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr.toString()}`);
};

interface Received {
  path: string;
  search: string;
  headers: Record<string, string>;
  body: { content: string; allowed_mentions: unknown } & Record<string, unknown>;
}
type Answer = { status: number; body?: string; headers?: Record<string, string> };
const received: Received[] = [];
/** Answers per webhook path, used in order; the last one repeats. Default 204. */
const answers = new Map<string, Answer[]>();
let server: ReturnType<typeof Bun.serve>;
let ca: string;

const toLoopback: Resolver = async () => [{ address: "127.0.0.1", family: 4 }];
let transport: DiscordTransport;

// --- the context -------------------------------------------------------------------------------

const logLines: string[] = [];
const logger = createLogger({ service: "worker-test-discord", level: "debug", write: (l) => logLines.push(l) });
const site = { name: "Air Test", publicUrl: "https://air.example" } as InstanceSite;
const START = new Date("2026-10-30T12:00:00.000Z");
let clock = START;
const enqueued: { name: string; data: unknown; opts?: EnqueueOptions }[] = [];

let t: TestDatabase;
let owner: Database;
let ctx: DiscordJobCtx;

beforeAll(async () => {
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "1",
    "-subj",
    "/CN=discord-test-ca",
  );
  openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "leaf.key",
    "-out",
    "leaf.csr",
    "-subj",
    "/CN=discord.com",
  );
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:discord.com,DNS:discordapp.com\n");
  openssl(
    "x509",
    "-req",
    "-in",
    "leaf.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "leaf.pem",
    "-days",
    "1",
    "-extfile",
    "ext.cnf",
  );
  ca = readFileSync(join(dir, "ca.pem"), "utf8");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: readFileSync(join(dir, "leaf.pem"), "utf8"), key: readFileSync(join(dir, "leaf.key"), "utf8") },
    async fetch(req) {
      const url = new URL(req.url);
      received.push({
        path: url.pathname,
        search: url.search,
        headers: Object.fromEntries([...req.headers].map(([k, v]) => [k.toLowerCase(), v])),
        body: (await req.json()) as Received["body"],
      });
      const list = answers.get(url.pathname) ?? [];
      const a = (list.length > 1 ? list.shift() : list[0]) ?? { status: 204 };
      return new Response(a.body ?? null, { status: a.status, headers: a.headers ?? {} });
    },
  });
  transport = { allowInsecure: true, resolve: toLoopback, ca, port: server.port };

  t = await createTestDatabase();
  owner = t.db;
  ctx = {
    db: t.app.db,
    logger,
    now: () => clock,
    enqueue: async (_queue, name, data, opts) => {
      enqueued.push({ name, data, ...(opts ? { opts } : {}) });
    },
    site,
    webhooks: { authSecret: AUTH_SECRET },
  };
}, 180_000);

afterAll(async () => {
  await server?.stop(true);
  rmSync(dir, { recursive: true, force: true });
  await t?.drop();
});

beforeEach(() => {
  clock = START;
  enqueued.length = 0;
  clearGoLiveSettingCache();
});

// --- helpers -----------------------------------------------------------------------------------

let hookSeq = 1000;
/** A streamer with a broadcast and a stored webhook; `path` is what the receiver sees. */
async function scene(opts: { title?: string; mature?: boolean; channelMature?: boolean; url?: string } = {}) {
  const streamer = await makeUser(owner);
  if (opts.channelMature)
    await owner.update(schema.channels).set({ mature: true }).where(eq(schema.channels.id, streamer.channel.id));
  const b = await makeBroadcast(owner, streamer.channel.id);
  await owner
    .update(schema.broadcasts)
    .set({ title: opts.title ?? "Late night synths", mature: opts.mature ?? false })
    .where(eq(schema.broadcasts.id, b.id));
  const token = `tok_${crypto.randomUUID().replace(/-/g, "")}`;
  const path = `/api/webhooks/${hookSeq++}/${token}`;
  const url = opts.url ?? `https://discord.com${path}`;
  await owner.insert(hooks).values({
    channelId: streamer.channel.id,
    url: await encryptSecret(AUTH_SECRET, NOTIFY_SECRET_PURPOSES.discordWebhook, url),
    setBy: streamer.user.id,
  });
  const goLive = () => ({ channelId: streamer.channel.id, eventId: uuidv7(), broadcastId: b.id, test: false });
  return { streamer, broadcast: b, path, token, url, goLive };
}

const hookOf = async (channelId: string) => (await owner.select().from(hooks).where(eq(hooks.channelId, channelId)))[0];
const postsTo = (path: string) => received.filter((r) => r.path === path);

describe("notify-discord job", () => {
  test("a go-live posts once, as plain text with mentions off, through the pinned TLS connection", async () => {
    const s = await scene({ title: "@everyone synths" });
    logLines.length = 0;
    const result = await runDiscordJob(s.goLive(), ctx, transport);
    expect(result).toEqual({ posted: 1, outcome: "posted" });

    const [post] = postsTo(s.path);
    expect(postsTo(s.path)).toHaveLength(1);
    expect(post!.search).toBe("?wait=false");
    expect(post!.headers["content-type"]).toBe("application/json");
    expect(post!.headers["user-agent"]).toBe("CommonAir-Notify/1");
    expect(post!.body).toEqual({
      content: `${s.streamer.channel.displayName} is live: @everyone synths https://air.example/${s.streamer.channel.slug}`,
      allowed_mentions: { parse: [] },
    });

    const row = await hookOf(s.streamer.channel.id);
    expect(row?.lastPostedAt?.toISOString()).toBe(START.toISOString());
    expect(row?.failures).toBe(0);
    expect(row?.lastError).toBeNull();
    // The URL (its token) is never logged.
    expect(logLines.join("\n")).not.toContain(s.token);
  });

  test("a mature broadcast or channel posts without the title", async () => {
    const a = await scene({ title: "Secret title", mature: true });
    await runDiscordJob(a.goLive(), ctx, transport);
    expect(postsTo(a.path)[0]!.body.content).toBe(
      `${a.streamer.channel.displayName} is live (18+) https://air.example/${a.streamer.channel.slug}`,
    );
    const b = await scene({ title: "Secret title", channelMature: true });
    await runDiscordJob(b.goLive(), ctx, transport);
    expect(postsTo(b.path)[0]!.body.content).not.toContain("Secret title");
  });

  test("a second go-live within the cooldown does not post; one after it does", async () => {
    const s = await scene();
    expect((await runDiscordJob(s.goLive(), ctx, transport)).posted).toBe(1);
    clock = new Date(START.getTime() + (DEFAULT_GO_LIVE_SETTING.cooldownHours * HOUR) / 2);
    expect(await runDiscordJob(s.goLive(), ctx, transport)).toEqual({ posted: 0, outcome: "cooldown" });
    expect(postsTo(s.path)).toHaveLength(1);
    clock = new Date(START.getTime() + DEFAULT_GO_LIVE_SETTING.cooldownHours * HOUR);
    expect((await runDiscordJob(s.goLive(), ctx, transport)).posted).toBe(1);
    expect(postsTo(s.path)).toHaveLength(2);
    expect((await hookOf(s.streamer.channel.id))?.lastPostedAt?.toISOString()).toBe(clock.toISOString());
  });

  test("a retried job after a successful post does not post again", async () => {
    const s = await scene();
    const data = s.goLive();
    expect((await runDiscordJob(data, ctx, transport, { id: `discord-${data.eventId}` })).posted).toBe(1);
    clock = new Date(START.getTime() + 60_000);
    expect(await runDiscordJob(data, ctx, transport, { id: `discord-${data.eventId}` })).toEqual({
      posted: 0,
      outcome: "cooldown",
    });
    expect(postsTo(s.path)).toHaveLength(1);
  });

  test("429 with a short retry_after throws for BullMQ and gives the claim back; the retry posts", async () => {
    const s = await scene();
    answers.set(s.path, [
      {
        status: 429,
        body: JSON.stringify({ message: "You are being rate limited.", retry_after: 0.4, global: false }),
      },
      { status: 204 },
    ]);
    const data = s.goLive();
    await expect(runDiscordJob(data, ctx, transport)).rejects.toBeInstanceOf(DiscordRetry);
    let row = await hookOf(s.streamer.channel.id);
    expect(row?.lastPostedAt).toBeNull();
    expect(row?.lastError).toBe("rate_limited");
    expect(enqueued).toHaveLength(0);

    clock = new Date(START.getTime() + 1_000);
    expect(await runDiscordJob(data, ctx, transport)).toEqual({ posted: 1, outcome: "posted" });
    row = await hookOf(s.streamer.channel.id);
    expect(row?.lastPostedAt?.toISOString()).toBe(clock.toISOString());
    expect(row?.lastError).toBeNull();
    expect(postsTo(s.path)).toHaveLength(2);
  });

  test("429 with a wait longer than the backoff re-enqueues with that delay, at most three times", async () => {
    const s = await scene();
    answers.set(s.path, [{ status: 429, body: "", headers: { "retry-after": "120" } }]);
    const data = s.goLive();
    const base = `discord-${data.eventId}`;
    expect(await runDiscordJob(data, ctx, transport, { id: base })).toEqual({ posted: 0, outcome: "rescheduled" });
    expect(enqueued).toEqual([{ name: "discord", data, opts: { jobId: `${base}-retry-1`, delayMs: 120_000 } }]);
    expect(await runDiscordJob(data, ctx, transport, { id: `${base}-retry-2` })).toEqual({
      posted: 0,
      outcome: "rescheduled",
    });
    expect(enqueued[1]?.opts?.jobId).toBe(`${base}-retry-3`);
    // The cap: the third copy throws instead (BullMQ's own attempts take over).
    await expect(runDiscordJob(data, ctx, transport, { id: `${base}-retry-3` })).rejects.toBeInstanceOf(DiscordRetry);
    expect(enqueued).toHaveLength(2);
    expect((await hookOf(s.streamer.channel.id))?.lastPostedAt).toBeNull();
  });

  test("5xx throws and gives the claim back", async () => {
    const s = await scene();
    answers.set(s.path, [{ status: 502 }]);
    await expect(runDiscordJob(s.goLive(), ctx, transport)).rejects.toBeInstanceOf(DiscordRetry);
    const row = await hookOf(s.streamer.channel.id);
    expect(row?.lastPostedAt).toBeNull();
    expect(row?.lastError).toBe("network");
  });

  test("another 4xx is rejected: not retried, the claim given back", async () => {
    const s = await scene();
    answers.set(s.path, [{ status: 400, body: "{}" }]);
    expect(await runDiscordJob(s.goLive(), ctx, transport)).toEqual({ posted: 0, outcome: "rejected" });
    const row = await hookOf(s.streamer.channel.id);
    expect(row?.lastError).toBe("rejected");
    expect(row?.failures).toBe(0);
    expect(row?.lastPostedAt).toBeNull();
  });

  test("404 three times (three go-lives) removes the webhook, tells the owner and audits it", async () => {
    const s = await scene();
    answers.set(s.path, [{ status: 404, body: JSON.stringify({ message: "Unknown Webhook", code: 10015 }) }]);
    const channelId = s.streamer.channel.id;
    for (let i = 1; i < NOTIFY_RULES.discordFailureLimit; i++) {
      clock = new Date(START.getTime() + i * 60_000);
      expect(await runDiscordJob(s.goLive(), ctx, transport)).toEqual({ posted: 0, outcome: "gone" });
      const row = await hookOf(channelId);
      expect(row?.failures).toBe(i);
      expect(row?.lastError).toBe("not_found");
      // Nothing went out, so the next go-live is not cooled down.
      expect(row?.lastPostedAt).toBeNull();
    }
    expect(await runDiscordJob(s.goLive(), ctx, transport)).toEqual({ posted: 0, outcome: "gone" });
    expect(postsTo(s.path)).toHaveLength(NOTIFY_RULES.discordFailureLimit);
    expect(await hookOf(channelId)).toBeUndefined();

    const notes = await owner
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, s.streamer.user.id), eq(schema.notifications.type, "system")));
    expect(notes.map((n) => n.payload)).toEqual([{ kind: "discord_webhook_removed", channelId }]);
    const audits = await owner.select().from(schema.auditLog).where(eq(schema.auditLog.channelId, channelId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: "system",
      actorId: null,
      action: "discord_webhook.remove",
      subjectType: "channel",
      subjectId: channelId,
      details: { action: "auto_remove" },
    });
    expect(JSON.stringify(audits)).not.toContain(s.token);
    // The next go-live finds no webhook.
    expect(await runDiscordJob(s.goLive(), ctx, transport)).toEqual({ posted: 0, outcome: "none" });
  });

  test("401 counts like 404", async () => {
    const s = await scene();
    answers.set(s.path, [{ status: 401 }]);
    await runDiscordJob(s.goLive(), ctx, transport);
    expect(await hookOf(s.streamer.channel.id)).toMatchObject({ failures: 1, lastError: "unauthorized" });
  });

  test("a post that works resets the failure count", async () => {
    const s = await scene();
    answers.set(s.path, [{ status: 404 }, { status: 204 }]);
    await runDiscordJob(s.goLive(), ctx, transport);
    expect((await hookOf(s.streamer.channel.id))?.failures).toBe(1);
    expect((await runDiscordJob(s.goLive(), ctx, transport)).posted).toBe(1);
    expect(await hookOf(s.streamer.channel.id)).toMatchObject({ failures: 0, lastError: null });
  });

  test("a test post ignores the cooldown and leaves it alone", async () => {
    const s = await scene();
    expect((await runDiscordJob(s.goLive(), ctx, transport)).posted).toBe(1);
    clock = new Date(START.getTime() + 60_000);
    const testData = { channelId: s.streamer.channel.id, eventId: null, broadcastId: null, test: true };
    expect(await runDiscordJob(testData, ctx, transport)).toEqual({ posted: 1, outcome: "posted" });
    expect(await runDiscordJob(testData, ctx, transport)).toEqual({ posted: 1, outcome: "posted" });
    const posts = postsTo(s.path);
    expect(posts).toHaveLength(3);
    expect(posts[1]!.body).toEqual({
      content: `Test from Air Test: go-live posts for ${s.streamer.channel.displayName} will appear here.`,
      allowed_mentions: { parse: [] },
    });
    // A test never takes the go-live cooldown.
    expect((await hookOf(s.streamer.channel.id))?.lastPostedAt?.toISOString()).toBe(START.toISOString());
  });

  test("a test post before going live does not hold back the go-live", async () => {
    const s = await scene();
    const testData = { channelId: s.streamer.channel.id, eventId: null, broadcastId: null, test: true };
    expect((await runDiscordJob(testData, ctx, transport)).posted).toBe(1);
    expect((await runDiscordJob(s.goLive(), ctx, transport)).posted).toBe(1);
  });

  test("an SSRF rejection deletes the webhook without connecting", async () => {
    const s = await scene();
    const r = await runDiscordJob(s.goLive(), ctx, {
      allowInsecure: false,
      resolve: toLoopback,
      ca,
      port: server.port,
    });
    expect(r).toEqual({ posted: 0, outcome: "blocked" });
    expect(postsTo(s.path)).toHaveLength(0);
    expect(await hookOf(s.streamer.channel.id)).toBeUndefined();
    const notes = await owner
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, s.streamer.user.id));
    expect(notes.map((n) => n.payload)).toEqual([
      { kind: "discord_webhook_removed", channelId: s.streamer.channel.id },
    ]);
  });

  test("the registered handler never allows loopback: discord.com resolving to 127.0.0.1 is refused", async () => {
    const s = await scene();
    const handlerCtx = { ...ctx, webhooks: { ...ctx.webhooks, resolve: toLoopback } } as unknown as WorkerContext;
    const r = await discordJobDef.handler(s.goLive(), handlerCtx, { id: undefined, attemptsMade: 0 });
    expect(r).toEqual({ posted: 0, outcome: "blocked" });
    expect(postsTo(s.path)).toHaveLength(0);
  });

  test("a stored URL that is not a Discord webhook is never posted and is removed", async () => {
    const s = await scene({ url: "https://evil.example/api/webhooks/1/abc" });
    expect(await runDiscordJob(s.goLive(), ctx, transport)).toEqual({ posted: 0, outcome: "blocked" });
    expect(await hookOf(s.streamer.channel.id)).toBeUndefined();
  });

  test("no webhook, or a broadcast of another channel: nothing happens", async () => {
    const s = await scene();
    const other = await scene();
    expect(await runDiscordJob({ ...s.goLive(), broadcastId: other.broadcast.id }, ctx, transport)).toEqual({
      posted: 0,
      outcome: "missing",
    });
    const lone = await makeUser(owner);
    expect(
      await runDiscordJob(
        { channelId: lone.channel.id, eventId: uuidv7(), broadcastId: null, test: false },
        ctx,
        transport,
      ),
    ).toEqual({ posted: 0, outcome: "none" });
    expect(postsTo(s.path)).toHaveLength(0);
  });
});
