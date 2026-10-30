// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { KEYS } from "@commonair/contracts/internal";
import { createLogger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import { ChannelLatency, parseLatency } from "../src/chat-latency.ts";

/** A stand-in for the one call the reader makes. */
function fakeValkey(get: (key: string) => Promise<string | null>) {
  const calls: string[] = [];
  const valkey = {
    get: (key: string) => {
      calls.push(key);
      return get(key);
    },
  } as unknown as ValkeyClient;
  return { valkey, calls };
}

function collector() {
  const lines: { level: string; msg: string }[] = [];
  const logger = createLogger({
    service: "chat-test",
    level: "debug",
    write: (l) => lines.push(JSON.parse(l) as { level: string; msg: string }),
  });
  return { logger, lines };
}

describe("parseLatency", () => {
  test("accepts seconds, integer or fractional", () => {
    expect(parseLatency("4")).toBe(4);
    expect(parseLatency("2.75")).toBe(2.75);
    expect(parseLatency("0")).toBe(0);
  });

  test("caps at 60 s", () => {
    expect(parseLatency("61")).toBe(60);
  });

  test("missing or malformed → null", () => {
    for (const raw of [null, undefined, "", "  ", "abc", "4s", "-1", "NaN", "Infinity"]) {
      expect(parseLatency(raw)).toBeNull();
    }
  });
});

describe("ChannelLatency", () => {
  test("reads KEYS.chatLatency and caches per channel", async () => {
    const { valkey, calls } = fakeValkey(async () => "3.5");
    const latency = new ChannelLatency(valkey, { ttlMs: 60_000 });
    expect(await latency.get("ch-1")).toBe(3.5);
    expect(await latency.get("ch-1")).toBe(3.5);
    expect(calls).toEqual([KEYS.chatLatency("ch-1")]);
    expect(await latency.get("ch-2")).toBe(3.5);
    expect(calls).toHaveLength(2);
  });

  test("concurrent reads share one round trip", async () => {
    const { valkey, calls } = fakeValkey(async () => "2");
    const latency = new ChannelLatency(valkey);
    expect(await Promise.all([latency.get("c"), latency.get("c"), latency.get("c")])).toEqual([2, 2, 2]);
    expect(calls).toHaveLength(1);
  });

  test("re-reads after the TTL", async () => {
    let value = "1";
    const { valkey, calls } = fakeValkey(async () => value);
    const latency = new ChannelLatency(valkey, { ttlMs: 20 });
    expect(await latency.get("c")).toBe(1);
    value = "5";
    await Bun.sleep(30);
    expect(await latency.get("c")).toBe(5);
    expect(calls).toHaveLength(2);
  });

  test("a missing key is null", async () => {
    const { valkey } = fakeValkey(async () => null);
    expect(await new ChannelLatency(valkey).get("c")).toBeNull();
  });

  test("a malformed value is null", async () => {
    const { valkey } = fakeValkey(async () => "fast");
    expect(await new ChannelLatency(valkey).get("c")).toBeNull();
  });

  test("a Valkey error is null with a debug log, never a throw", async () => {
    const { valkey, calls } = fakeValkey(() => Promise.reject(new Error("connection refused")));
    const { logger, lines } = collector();
    const latency = new ChannelLatency(valkey, { logger });
    expect(await latency.get("c")).toBeNull();
    expect(lines).toEqual([expect.objectContaining({ level: "debug", msg: "chat latency read failed" })]);
    // Cached for the TTL: an outage costs one read per channel per TTL.
    expect(await latency.get("c")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("a hung Valkey read times out as null", async () => {
    const { valkey } = fakeValkey(() => new Promise<string | null>(() => {}));
    const { logger, lines } = collector();
    const latency = new ChannelLatency(valkey, { timeoutMs: 10, logger });
    expect(await latency.get("c")).toBeNull();
    expect(lines.map((l) => l.msg)).toEqual(["chat latency read timed out"]);
  });
});
