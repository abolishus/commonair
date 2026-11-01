// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { createLogger } from "@commonair/observability";
import { registerCaptions } from "../src/captions/index.ts";
import type { MediaContext } from "../src/context.ts";
import { MediaSessionHooks, type MediaSessionInfo } from "../src/hooks.ts";

const session: MediaSessionInfo = {
  broadcastId: "0192f3a4-5b6c-7d8e-9f01-0000000000b1",
  channelId: "0192f3a4-5b6c-7d8e-9f01-0000000000c1",
  slug: "alice",
  path: "live/alice",
  kind: "live",
  startedAt: new Date("2026-10-31T12:00:00Z"),
  vodId: null,
};
const logger = createLogger({ service: "media-test", level: "fatal" });

describe("MediaSessionHooks", () => {
  test("runs every hook's onStart and onEnd with the session", async () => {
    const hooks = new MediaSessionHooks(logger);
    const calls: string[] = [];
    for (const name of ["a", "b"])
      hooks.register({
        name,
        onStart: async (s) => void calls.push(`${name}:start:${s.broadcastId}`),
        onEnd: async (s, { final }) => void calls.push(`${name}:end:${s.kind}:${final}`),
      });
    await hooks.start(session);
    await hooks.end(session, { final: true });
    expect(calls).toEqual([
      `a:start:${session.broadcastId}`,
      `b:start:${session.broadcastId}`,
      "a:end:live:true",
      "b:end:live:true",
    ]);
    expect(hooks.names).toEqual(["a", "b"]);
  });

  test("a failing hook never rejects and never stops the others", async () => {
    const hooks = new MediaSessionHooks(logger);
    let ended = 0;
    hooks.register({
      name: "broken",
      onStart: () => Promise.reject(new Error("boom")),
      onEnd: () => {
        throw new Error("sync boom");
      },
    });
    hooks.register({ name: "ok", onStart: async () => {}, onEnd: async () => void ended++ });
    await expect(hooks.start(session)).resolves.toBeUndefined();
    await expect(hooks.end(session, { final: false })).resolves.toBeUndefined();
    expect(ended).toBe(1);
  });

  test("end waits for a slow hook (VOD writes finish before finalize is enqueued)", async () => {
    const hooks = new MediaSessionHooks(logger);
    let written = false;
    hooks.register({
      name: "slow",
      onStart: async () => {},
      onEnd: async () => {
        await Bun.sleep(30);
        written = true;
      },
    });
    await hooks.end(session, { final: true });
    expect(written).toBe(true);
  });

  test("refuses a second hook with the same name", () => {
    const hooks = new MediaSessionHooks();
    hooks.register({ name: "x", onStart: async () => {}, onEnd: async () => {} });
    expect(() => hooks.register({ name: "x", onStart: async () => {}, onEnd: async () => {} })).toThrow(/already/);
  });
});

describe("captions registration", () => {
  test("registers a no-op hook with its own slot limiter sized by CAPTIONS_MAX_STREAMS", async () => {
    const hooks = new MediaSessionHooks(logger);
    const ctx = { transcodeSlots: { capacity: 4 } } as unknown as MediaContext;
    const runtime = registerCaptions(hooks, { ctx, env: { CAPTIONS_MAX_STREAMS: 2, WHISPER_URL: undefined } });
    expect(hooks.names).toEqual(["captions"]);
    expect(runtime.slots.capacity).toBe(2);
    expect(runtime.slots).not.toBe(ctx.transcodeSlots);
    await hooks.start(session);
    await hooks.end(session, { final: true });
    expect(runtime.slots.inUse).toBe(0);
  });
});
