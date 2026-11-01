// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The instance flags and the jitter secret the verified-watch writer and the surge guard read (ADR 0015, 0039). */
import { chatEnv, giveawaysEnv, internalEnv, loadEnv } from "@commonair/config";
import { z } from "zod";

export interface ChatGateConfig {
  /** `CHAT_WATCH_GATE` (decision 7). */
  watchGate: boolean;
  /** `CHAT_SURGE_GUARD` (decision 6). */
  surgeGuard: boolean;
  /**
   * `GIVEAWAYS_ENABLED` (ADR 0039 decision (t)): an open giveaway that asks for verified watching
   * makes the writer measure its channel.
   */
  giveaways: boolean;
  /** `INTERNAL_API_SECRET`: the jitter's HMAC key (decision 4). */
  secret: string;
}

const gateEnv = z.object({
  CHAT_WATCH_GATE: chatEnv.shape.CHAT_WATCH_GATE,
  CHAT_SURGE_GUARD: chatEnv.shape.CHAT_SURGE_GUARD,
  GIVEAWAYS_ENABLED: giveawaysEnv.shape.GIVEAWAYS_ENABLED,
  INTERNAL_API_SECRET: internalEnv.shape.INTERNAL_API_SECRET,
});

let cached: ChatGateConfig | undefined;

/** Read once per process from the env `workerEnv` validated at start-up; tests pass their own. */
export function chatGateConfig(source?: Record<string, string | undefined>): ChatGateConfig {
  if (!source && cached) return cached;
  const env = loadEnv(gateEnv, source ?? process.env);
  const cfg: ChatGateConfig = {
    watchGate: env.CHAT_WATCH_GATE === "on",
    surgeGuard: env.CHAT_SURGE_GUARD === "on",
    giveaways: env.GIVEAWAYS_ENABLED,
    secret: env.INTERNAL_API_SECRET,
  };
  if (!source) cached = cfg;
  return cfg;
}
