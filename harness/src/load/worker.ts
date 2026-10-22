#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Load-test child process: opens its slice of the HTTP audience (`WorkerSpec` in argv[2]),
 * reports `started`, holds until SIGINT/SIGTERM (or `maxMs`), then prints every viewer's final
 * report on one protocol line and exits. Logs go to stderr; stdout carries only the protocol.
 */
import { createLogger } from "@commonair/observability";
import { loadHarnessEnv } from "../env.ts";
import { Platform } from "../platform.ts";
import type { Viewer } from "../viewer.ts";
import { type ShardMessage, type WorkerSpec, formatShardLine } from "./shard.ts";

const send = (msg: ShardMessage) => process.stdout.write(`${formatShardLine(msg)}\n`);

async function main(raw: string | undefined): Promise<number> {
  if (!raw) {
    console.error("usage: bun harness/src/load/worker.ts '<WorkerSpec JSON>'");
    return 2;
  }
  const spec = JSON.parse(raw) as WorkerSpec;
  const env = loadHarnessEnv();
  const log = createLogger({
    service: "harness-load-shard",
    level: env.LOG_LEVEL,
    base: { run: spec.runId, shard: spec.shard.index },
    write: (line) => process.stderr.write(`${line}\n`),
  });
  const platform = new Platform(env, log, `${spec.runId}s${spec.shard.index}`);
  const viewers: Viewer[] = [];
  let release: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });
  process.once("SIGINT", () => release());
  process.once("SIGTERM", () => release());
  const timer = setTimeout(() => release(), spec.maxMs);
  try {
    for (const { channel, http } of spec.shard.channels) {
      viewers.push(...(await platform.openViewers(channel, { http })));
    }
    send({ type: "started", shard: spec.shard.index, viewers: viewers.length });
    await stopped;
    const reports = await Promise.all(viewers.map((v) => v.stop()));
    send({ type: "reports", shard: spec.shard.index, reports });
    return 0;
  } catch (err) {
    send({ type: "error", shard: spec.shard.index, error: err instanceof Error ? err.message : String(err) });
    await Promise.allSettled(viewers.map((v) => v.stop()));
    return 1;
  } finally {
    clearTimeout(timer);
    await platform.close();
  }
}

if (import.meta.main) {
  main(process.argv[2]).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
