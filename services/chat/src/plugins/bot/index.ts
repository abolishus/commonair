// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The built-in channel bot (E8, ADR 0026 decision 6): commands, timers, song requests, points and
 * the spam, caps and link filters. Until `init` runs, every message passes through untouched.
 */
import type { MessageMiddleware } from "../../pipeline.ts";
import { BotEngine, type BotEngineOptions } from "./engine.ts";

export { BotEngine, type BotEngineOptions } from "./engine.ts";

export interface BotMiddleware extends MessageMiddleware {
  /** The engine after `init` (tests drive timers through it). */
  engine(): BotEngine | null;
}

/**
 * One middleware per chat service. `init` again (a second service in the same process sharing the
 * registry's instance) replaces the engine; the previous one's timers stop, and the first service's
 * messages then run through the second one's host. Production runs one service per process; tests
 * that start two services pass each its own `createBotMiddleware()` until the registry hands out
 * fresh middlewares per service.
 */
export function createBotMiddleware(opts: BotEngineOptions = {}): BotMiddleware {
  let engine: BotEngine | null = null;
  return {
    name: "channel-bot",
    engine: () => engine,
    async init(host) {
      engine?.stop();
      const next = new BotEngine(host, opts);
      await next.start();
      engine = next;
    },
    async process(ctx) {
      return engine ? engine.process(ctx) : "continue";
    },
    async onMessage(ctx) {
      await engine?.onMessage(ctx);
    },
    async close() {
      engine?.stop();
    },
  };
}
