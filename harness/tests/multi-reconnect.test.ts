// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ServerFrame } from "@commonair/contracts";
import { describe, expect, test } from "vite-plus/test";
import { backoffDelay as webBackoffDelay } from "../../apps/web/src/chat/backoff.ts";
import { backoffDelay, backoffSchedule } from "../src/multi/backoff.ts";
import { type ChatLike, ReconnectingChat } from "../src/multi/reconnecting-chat.ts";

/** A seeded sequence, so jittered delays are deterministic. */
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length] as number;
};

describe("backoff", () => {
  test("the schedule doubles from 500 ms, capped at 30 s, minus up to 30 % jitter", () => {
    expect(backoffSchedule(8, () => 0)).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(backoffSchedule(3, () => 1)).toEqual([350, 700, 1400]);
    expect(backoffSchedule(4, sequence(0.5, 0, 1, 0.25))).toEqual([425, 1000, 1400, 3700]);
  });

  test("negative and huge attempts stay in range", () => {
    expect(backoffDelay(-3, {}, () => 0)).toBe(500);
    expect(backoffDelay(1_000, {}, () => 0)).toBe(30_000);
  });

  test("is the web client's backoff, value for value", () => {
    for (let attempt = 0; attempt < 12; attempt++)
      for (const r of [0, 0.13, 0.5, 0.99, 1])
        expect(backoffDelay(attempt, {}, () => r)).toBe(webBackoffDelay(attempt, {}, () => r));
  });
});

class FakeChat implements ChatLike {
  isOpen = true;
  joined: string[] = [];
  private listeners = new Set<(f: ServerFrame) => void>();
  constructor(
    readonly url: string,
    private readonly failJoin = false,
  ) {}
  async join(channel: string): Promise<void> {
    if (this.failJoin) throw new Error("join refused");
    this.joined.push(channel);
  }
  onFrame(l: (f: ServerFrame) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(f: ServerFrame): void {
    for (const l of this.listeners) l(f);
  }
  close(): void {
    this.isOpen = false;
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function harness(plan: (url: string, n: number) => FakeChat | Error) {
  const sockets: FakeChat[] = [];
  const slept: number[] = [];
  let n = 0;
  let clock = 1_000;
  const chat = new ReconnectingChat<FakeChat>({
    channel: "room",
    endpoints: ["chat-2", "chat-1"],
    urlFor: async (ep) => `ws://${ep}/ws?token=t${n}`,
    connect: async (url) => {
      const r = plan(url, n++);
      if (r instanceof Error) throw r;
      sockets.push(r);
      return r;
    },
    random: () => 0,
    now: () => clock,
    sleep: async (ms) => {
      if (ms !== 5) slept.push(ms);
      clock += ms;
      await tick();
    },
    pollMs: 5,
  });
  return { chat, sockets, slept, advance: (ms: number) => (clock += ms) };
}

const message = (body: string): ServerFrame => ({
  op: "message",
  channel: "room",
  message: {
    id: crypto.randomUUID(),
    channelId: crypto.randomUUID(),
    user: {
      id: crypto.randomUUID(),
      username: "u",
      displayName: "u",
      color: "#fff",
      badges: [],
      accountType: "human",
    },
    body,
    emotes: [],
    isAction: false,
    replyTo: null,
    createdAt: new Date().toISOString(),
  },
});

describe("ReconnectingChat", () => {
  test("first connection goes to the first endpoint and joins the channel", async () => {
    const h = harness((url) => new FakeChat(url));
    const first = await h.chat.start();
    expect(first.endpoint).toBe("chat-2");
    expect(h.sockets[0]?.joined).toEqual(["room"]);
    expect(h.chat.endpoint).toBe("chat-2");
    await h.chat.stop();
  });

  test("a closed socket reconnects to the next endpoint after the web client's first backoff", async () => {
    const h = harness((url) => new FakeChat(url));
    await h.chat.start();
    const lostAt = 5_000;
    h.advance(lostAt);
    h.sockets[0]?.close();
    const again = await h.chat.waitConnected(lostAt, 1_000);
    expect(again.endpoint).toBe("chat-1");
    expect(h.slept).toEqual([500]);
    expect(h.chat.connections.map((c) => c.endpoint)).toEqual(["chat-2", "chat-1"]);
    expect(h.chat.connections[0]?.closedAt).not.toBeNull();
    await h.chat.stop();
  });

  test("failed attempts back off exponentially and rotate endpoints; the counter resets once joined", async () => {
    // After the loss: connect fails (n=1), the join is refused (n=2), connect fails (n=3), then n=4 joins.
    const h = harness((url, n) =>
      n === 0
        ? new FakeChat(url)
        : n === 1 || n === 3
          ? new Error("refused")
          : n === 2
            ? new FakeChat(url, true)
            : new FakeChat(url),
    );
    await h.chat.start();
    h.sockets[0]?.close();
    const back = await h.chat.waitConnected(1_001, 1_000);
    expect(h.chat.attempts.map((a) => [a.endpoint, a.ok, a.waitedMs])).toEqual([
      ["chat-2", true, 0],
      ["chat-1", false, 500],
      ["chat-2", false, 1000],
      ["chat-1", false, 2000],
      ["chat-2", true, 4000],
    ]);
    expect(back.endpoint).toBe("chat-2");
    h.sockets.at(-1)?.close();
    await h.chat.waitConnected(back.connectedAt + 1, 1_000);
    // Reset after the join: the next loss waits the first delay again.
    expect(h.slept.at(-1)).toBe(500);
    await h.chat.stop();
  });

  test("frames from every connection are kept, in arrival order", async () => {
    const h = harness((url) => new FakeChat(url));
    await h.chat.start();
    h.sockets[0]?.emit(message("before"));
    h.sockets[0]?.close();
    await h.chat.waitConnected(1_001, 1_000);
    h.sockets[1]?.emit(message("after"));
    h.sockets[0]?.emit(message("ghost")); // the old socket's listener is gone
    expect(h.chat.messages().map((m) => m.body)).toEqual(["before", "after"]);
    await h.chat.stop();
  });

  test("waitConnected times out when no instance takes the client", async () => {
    const h = harness((url, n) => (n === 0 ? new FakeChat(url) : new Error("down")));
    await h.chat.start();
    h.sockets[0]?.close();
    await expect(h.chat.waitConnected(Number.MAX_SAFE_INTEGER, 50)).rejects.toThrow(/timed out/);
    await h.chat.stop();
  });

  test("stop closes the socket and ends the loop", async () => {
    const h = harness((url) => new FakeChat(url));
    await h.chat.start();
    await h.chat.stop();
    expect(h.sockets[0]?.isOpen).toBe(false);
    expect(h.chat.client).toBeNull();
  });
});
