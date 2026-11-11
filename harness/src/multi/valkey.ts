// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The scenario's read-only views of Valkey: the event bus (`BUS.events`, where the outbox relay
 * publishes every event exactly when it relays it) and BullMQ's completed jobs.
 */
import { BUS, BusEvent } from "@commonair/contracts/events";
import { RedisClient } from "bun";
import { type JobRun, jobRunFromHash } from "./jobs.ts";

export interface BusListener {
  /** Messages on the bus that are not JSON or fail the `BusEvent` contract. */
  readonly invalid: number;
  stop(): Promise<void>;
}

/**
 * Subscribe to `BUS.events`; `onEvent` gets every event that matches the `BusEvent` contract
 * (@commonair/contracts/events). The rest are counted, not passed on. Resolves once subscribed.
 */
export async function listenToBus(url: string, onEvent: (e: BusEvent, at: number) => void): Promise<BusListener> {
  const client = new RedisClient(url);
  await client.connect();
  let invalid = 0;
  await client.subscribe(BUS.events, (message) => {
    const at = Date.now();
    const e = parseBusMessage(message);
    if (e) onEvent(e, at);
    else invalid++;
  });
  return {
    get invalid() {
      return invalid;
    },
    async stop() {
      await client.unsubscribe(BUS.events).catch(() => undefined);
      client.close();
    },
  };
}

/** One `BUS.events` message as a `BusEvent`, or null when it is not JSON or breaks the contract. */
export function parseBusMessage(message: string): BusEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(message);
  } catch {
    return null;
  }
  const parsed = BusEvent.safeParse(json);
  return parsed.success ? parsed.data : null;
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

/**
 * What spent a rate-limit bucket: its entries (`<ms>:<procedure>:<uuid>`, the API's
 * `rateLimitMember`) counted per procedure, most first. Pure.
 */
export function spendByProcedure(members: readonly string[]): { procedure: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const m of members) {
    const first = m.indexOf(":");
    const last = m.lastIndexOf(":");
    const procedure = first >= 0 && last > first ? m.slice(first + 1, last) || "?" : "?";
    counts.set(procedure, (counts.get(procedure) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([procedure, count]) => ({ procedure, count }))
    .sort((x, y) => y.count - x.count || x.procedure.localeCompare(y.procedure));
}

/** The live entries of the API's rate-limit bucket `key` (`rl:<bucket>:<subject>`), per procedure. */
export async function rateLimitSpend(url: string, key: string): Promise<{ procedure: string; count: number }[]> {
  const client = new RedisClient(url);
  try {
    await client.connect();
    const members = (await client.send("ZRANGE", [key, "0", "-1"])) as unknown[];
    return spendByProcedure(members.map(String));
  } finally {
    client.close();
  }
}
