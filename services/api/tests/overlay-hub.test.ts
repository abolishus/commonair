// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The overlay hub's failure paths, with a fake subscriber and token lookup: a Valkey failure while
 * a stream opens answers 503 and leaves nothing counted (the next open retries), and a token
 * re-check that never settles closes the stream instead of holding off every later check. `start()`
 * opens the subscriber before any stream, and an open that waits on a hung subscribe past the join
 * deadline answers 503 rather than hanging.
 */
import type { Valkey } from "iovalkey";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { BUS } from "@commonair/contracts/events";
import type { Deps } from "../src/deps.ts";
import { OVERLAY_HUB_DEFAULTS, OverlayHub, type OverlayHubIo } from "../src/overlay/stream.ts";
import type { ResolvedOverlayToken } from "../src/overlay/tokens.ts";

const CH = "0190f0aa-0000-7000-8000-000000000001";
const TOKEN: ResolvedOverlayToken = { id: "0190f0aa-0000-7000-8000-0000000000aa", channelId: CH, expiresAt: null };

const deps = {
  env: { VALKEY_URL: "redis://fake" },
  logger: { warn: () => undefined, error: () => undefined, info: () => undefined },
  db: {},
  now: () => new Date(),
} as unknown as Deps;

/**
 * A subscriber whose `subscribe(channel)` fails while `failing(channel)` says so, and never
 * answers while `hung(channel)` does.
 */
function fakeValkey(failing: (channel: string) => boolean, hung: (channel: string) => boolean = () => false) {
  const subscribed: string[] = [];
  let disconnects = 0;
  const v = {
    on: () => v,
    subscribe: async (channel: string) => {
      if (hung(channel)) return new Promise<never>(() => undefined);
      if (failing(channel)) throw new Error("Reached the max retries per request limit");
      subscribed.push(channel);
      return 1;
    },
    unsubscribe: async () => 0,
    disconnect: () => {
      disconnects++;
    },
  };
  return { client: v as unknown as Valkey, subscribed, disconnects: () => disconnects };
}

const hubs: OverlayHub[] = [];
function hub(io: Partial<OverlayHubIo>, opts: Partial<typeof OVERLAY_HUB_DEFAULTS> = {}) {
  const h = new OverlayHub(
    deps,
    { ...OVERLAY_HUB_DEFAULTS, ...opts },
    { connect: () => fakeValkey(() => false).client, resolve: async () => TOKEN, ...io },
  );
  hubs.push(h);
  return h;
}
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close();
});

const open = (h: OverlayHub) => h.open(TOKEN, "hash", new AbortController().signal);

describe("OverlayHub", () => {
  test("the shared subscribe failing → 503, nothing counted, and the next open reconnects", async () => {
    let down = true;
    const made: ReturnType<typeof fakeValkey>[] = [];
    const h = hub({
      connect: () => {
        const f = fakeValkey(() => down);
        made.push(f);
        return f.client;
      },
    });
    for (let i = 0; i < 3; i++) {
      const r = await open(h);
      expect(r.status).toBe(503);
      expect(h.count()).toBe(0);
      expect(h.count(CH)).toBe(0);
    }
    // Each failed client was dropped and a fresh one made.
    expect(made.length).toBe(3);
    expect(made.every((f) => f.disconnects() === 1)).toBe(true);

    down = false;
    const ok = await open(h);
    expect(ok.status).toBe(200);
    expect(h.count(CH)).toBe(1);
    expect(made.at(-1)?.subscribed).toEqual([BUS.events, BUS.overlay(CH)]);
    await ok.body?.cancel();
    expect(h.count()).toBe(0);
  });

  test("the channel subscribe failing → 503 without leaking a slot; the channel is subscribed on retry", async () => {
    let down = true;
    const f = fakeValkey((c) => down && c === BUS.overlay(CH));
    const h = hub({ connect: () => f.client }, { maxPerChannel: 2 });
    for (let i = 0; i < 5; i++) {
      expect((await open(h)).status).toBe(503);
      expect(h.count(CH)).toBe(0);
      expect(h.count()).toBe(0);
    }
    down = false;
    const ok = await open(h);
    // Not 429: the failed opens hold no slots.
    expect(ok.status).toBe(200);
    expect(f.subscribed).toContain(BUS.overlay(CH));
    await ok.body?.cancel();
    expect(h.count(CH)).toBe(0);
  });

  test("a re-check that never settles closes the stream (fail closed)", async () => {
    const h = hub({ resolve: () => new Promise<never>(() => undefined) }, { recheckMs: 30, checkTimeoutMs: 60 });
    const r = await open(h);
    expect(r.status).toBe(200);
    expect(h.count(CH)).toBe(1);
    const reader = r.body?.getReader();
    if (!reader) throw new Error("no body");
    const deadline = Date.now() + 2000;
    let done = false;
    while (!done && Date.now() < deadline) done = (await reader.read()).done;
    expect(done).toBe(true);
    expect(h.count(CH)).toBe(0);
  });

  test("start() opens the subscriber before any stream and retries until it listens", async () => {
    let down = true;
    const made: ReturnType<typeof fakeValkey>[] = [];
    const h = hub(
      {
        connect: () => {
          const f = fakeValkey(() => down);
          made.push(f);
          return f.client;
        },
      },
      { warmRetryMs: 10 },
    );
    expect(h.warm).toBe(false);
    h.start();
    await waitUntil(() => made.length >= 2);
    expect(h.warm).toBe(false);
    down = false;
    await waitUntil(() => h.warm);
    expect(made.at(-1)?.subscribed).toEqual([BUS.events]);
    expect(h.count()).toBe(0);
    // The first open reuses the warm subscriber.
    const before = made.length;
    const ok = await open(h);
    expect(ok.status).toBe(200);
    expect(made.length).toBe(before);
    await ok.body?.cancel();
  });

  test("a hung subscribe → 503 with Retry-After within the deadline, nothing counted; later opens recover", async () => {
    let hung = true;
    // iovalkey eventually rejects a stalled command (MaxRetriesPerRequestError); the test does so by hand.
    const stalled: ((err: Error) => void)[] = [];
    const made: ReturnType<typeof fakeValkey>[] = [];
    const h = hub(
      {
        connect: () => {
          const f = fakeValkey(() => false);
          const client = f.client as unknown as Record<string, unknown>;
          const plain = client.subscribe as (c: string) => Promise<number>;
          client.subscribe = (c: string) =>
            hung ? new Promise<number>((_, reject) => stalled.push(reject)) : plain(c);
          made.push(f);
          return f.client;
        },
      },
      { joinTimeoutMs: 50 },
    );
    for (let i = 0; i < 2; i++) {
      const started = Date.now();
      const r = await open(h);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(r.status).toBe(503);
      expect(r.headers.get("retry-after")).toBe("1");
      expect(await r.json()).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      expect(h.count()).toBe(0);
      expect(h.count(CH)).toBe(0);
    }
    // Both opens waited on the one pending subscribe.
    expect(made.length).toBe(1);
    expect(h.warm).toBe(false);

    hung = false;
    for (const reject of stalled) reject(new Error("Reached the max retries per request limit"));
    await new Promise((r) => setTimeout(r, 10));
    expect(made[0]?.disconnects()).toBe(1);
    expect(h.count()).toBe(0);

    const ok = await open(h);
    expect(ok.status).toBe(200);
    expect(made.length).toBe(2);
    expect(h.warm).toBe(true);
    expect(h.count(CH)).toBe(1);
    await ok.body?.cancel();
    expect(h.count()).toBe(0);
  });

  test("a channel subscribe that settles after the deadline leaves nothing counted or subscribed", async () => {
    let release: () => void = () => undefined;
    const unsubscribed: string[] = [];
    const f = fakeValkey(() => false);
    const client = f.client as unknown as Record<string, unknown>;
    const plain = client.subscribe as (c: string) => Promise<number>;
    client.subscribe = (c: string) =>
      c === BUS.overlay(CH) ? new Promise<number>((r) => (release = () => r(1))) : plain(c);
    client.unsubscribe = async (c: string) => {
      unsubscribed.push(c);
      return 0;
    };
    const h = hub({ connect: () => f.client }, { joinTimeoutMs: 50 });
    const r = await open(h);
    expect(r.status).toBe(503);
    expect(h.count(CH)).toBe(0);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.count()).toBe(0);
    expect(unsubscribed).toContain(BUS.overlay(CH));
    // The shared subscriber is fine, so the next open succeeds and subscribes the channel again.
    client.subscribe = plain;
    const ok = await open(h);
    expect(ok.status).toBe(200);
    expect(h.count(CH)).toBe(1);
    await ok.body?.cancel();
  });
});

describe("OverlayHub goal frames (E8)", () => {
  const OTHER = "0190f0aa-0000-7000-8000-000000000002";
  const OTHER_TOKEN: ResolvedOverlayToken = { ...TOKEN, id: "0190f0aa-0000-7000-8000-0000000000bb", channelId: OTHER };
  const GOAL = "0190f0aa-0000-7000-8000-0000000000c1";
  const STARTED = "2026-10-29T12:00:00.000Z";

  /** A subscriber that keeps its `message` handler, so the test can deliver bus messages. */
  function deliveringValkey() {
    let onMessage: ((channel: string, message: string) => void) | null = null;
    const v = {
      on: (event: string, fn: (channel: string, message: string) => void) => {
        if (event === "message") onMessage = fn;
        return v;
      },
      subscribe: async () => 1,
      unsubscribe: async () => 0,
      disconnect: () => undefined,
    };
    return {
      client: v as unknown as Valkey,
      deliver: (channel: string, message: unknown) => onMessage?.(channel, JSON.stringify(message)),
    };
  }

  /** Collect the SSE frames of a response body. */
  function frames(res: Response) {
    const out: { event: string; data: unknown }[] = [];
    const body = res.body;
    if (!body) throw new Error("no body");
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
        if (done) return;
        buf += dec.decode(value, { stream: true });
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(raw)?.[1];
          const data = /^data: (.*)$/m.exec(raw)?.[1];
          if (event && data) out.push({ event, data: JSON.parse(data) });
        }
      }
    })();
    return { goals: () => out.filter((x) => x.event === "goal").map((x) => x.data), cancel: () => reader.cancel() };
  }

  let seq = 0;
  const goalEvent = (type: string, channelId: string, payload: Record<string, unknown>) => ({
    id: `0190f0aa-0000-7000-8000-${String(++seq).padStart(12, "0")}`,
    type,
    version: "1",
    channelId,
    payload: {
      broadcaster_user_id: "0190f0aa-0000-7000-8000-0000000000a1",
      broadcaster_user_login: "chan",
      broadcaster_user_name: "Chan",
      id: GOAL,
      type: "followers",
      description: "Two follows",
      current_amount: 0,
      target_amount: 2,
      started_at: STARTED,
      ...payload,
    },
    occurredAt: "2026-10-29T12:00:01.000Z",
  });
  const dto = (current: number, endedAt: string | null = null) => ({
    id: GOAL,
    type: "followers",
    title: "Two follows",
    target: 2,
    current,
    startedAt: STARTED,
    endedAt,
  });

  test("channel.goal.* → a `goal` frame (the Goal DTO) on that channel's streams only", async () => {
    const f = deliveringValkey();
    const h = hub({ connect: () => f.client, resolve: async (_db, hash) => (hash === "other" ? OTHER_TOKEN : TOKEN) });
    const mine = await open(h);
    const theirs = await h.open(OTHER_TOKEN, "other", new AbortController().signal);
    expect([mine.status, theirs.status]).toEqual([200, 200]);
    const a = frames(mine);
    const b = frames(theirs);

    const ended = "2026-10-29T12:05:00.000Z";
    f.deliver(BUS.events, goalEvent("channel.goal.begin", CH, {}));
    f.deliver(BUS.events, goalEvent("channel.goal.progress", CH, { current_amount: 1 }));
    f.deliver(BUS.events, goalEvent("channel.goal.end", CH, { current_amount: 2, is_achieved: true, ended_at: ended }));
    // Malformed (a zero target fails the DTO): dropped, the stream stays healthy.
    f.deliver(BUS.events, goalEvent("channel.goal.progress", CH, { target_amount: 0 }));
    // A channel with no stream on this hub: nothing anywhere.
    f.deliver(BUS.events, goalEvent("channel.goal.progress", "0190f0aa-0000-7000-8000-000000000003", {}));

    await waitUntil(() => a.goals().length === 3);
    expect(a.goals()).toEqual([dto(0), dto(1), dto(2, ended)]);
    await new Promise((r) => setTimeout(r, 20));
    expect(a.goals()).toHaveLength(3);
    expect(b.goals()).toHaveLength(0);

    f.deliver(BUS.events, goalEvent("channel.goal.progress", OTHER, { current_amount: 1 }));
    await waitUntil(() => b.goals().length === 1);
    expect(a.goals()).toHaveLength(3);
    await a.cancel();
    await b.cancel();
  });
});

async function waitUntil(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}
