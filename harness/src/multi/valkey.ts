// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The scenario's read-only views of Valkey: the event bus (`BUS.events`, where the outbox relay
 * publishes every event exactly when it relays it) and BullMQ's completed jobs.
 */
import { BUS } from "@commonair/contracts/events";
import { RedisClient } from "bun";
import { type JobRun, jobRunFromHash } from "./jobs.ts";

export interface BusMessage {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface BusListener {
  stop(): Promise<void>;
}

/** Subscribe to `BUS.events`; `onEvent` gets every parsed event. Resolves once subscribed. */
export async function listenToBus(url: string, onEvent: (e: BusMessage, at: number) => void): Promise<BusListener> {
  const client = new RedisClient(url);
  await client.connect();
  await client.subscribe(BUS.events, (message) => {
    const at = Date.now();
    try {
      const e = JSON.parse(message) as Partial<BusMessage>;
      if (typeof e.id === "string" && typeof e.type === "string" && e.payload && typeof e.payload === "object")
        onEvent({ id: e.id, type: e.type, payload: e.payload }, at);
    } catch {
      // Not ours to judge: other consumers validate the bus.
    }
  });
  return {
    async stop() {
      await client.unsubscribe(BUS.events).catch(() => undefined);
      client.close();
    },
  };
}

/** Completed scheduler jobs of a BullMQ queue (prefix `bull`, as the worker runs it). */
export async function completedSchedulerRuns(url: string, queue: string, prefix = "bull"): Promise<JobRun[]> {
  const client = new RedisClient(url);
  try {
    await client.connect();
    const ids = (await client.send("ZRANGE", [`${prefix}:${queue}:completed`, "0", "-1"])) as string[];
    const runs: JobRun[] = [];
    for (const id of ids) {
      if (!id.startsWith("repeat:")) continue;
      const flat = (await client.send("HGETALL", [`${prefix}:${queue}:${id}`])) as string[] | Record<string, string>;
      const hash = Array.isArray(flat) ? pairs(flat) : flat;
      const run = jobRunFromHash(id, hash);
      if (run) runs.push(run);
    }
    return runs;
  } finally {
    client.close();
  }
}

function pairs(flat: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i] as string] = flat[i + 1] as string;
  return out;
}

/** The oldest completed job BullMQ still keeps (epoch ms), so a window is not read past it. */
export async function oldestCompleted(url: string, queue: string, prefix = "bull"): Promise<number | null> {
  const client = new RedisClient(url);
  try {
    await client.connect();
    const r = (await client.send("ZRANGE", [`${prefix}:${queue}:completed`, "0", "0", "WITHSCORES"])) as unknown[];
    const flat = r.flat() as unknown[];
    const score = Number(flat[1]);
    return Number.isFinite(score) ? score : null;
  } finally {
    client.close();
  }
}
