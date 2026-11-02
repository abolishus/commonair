// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-media's local peers, started in `run` and stopped before it returns: an RTMP sink (an
 * `ffmpeg -listen` on this machine, reached by the media service through `HARNESS_WEBHOOK_HOST`)
 * for streamer1's simulcast target, and the Go member relay (built from `relay/`, registered with
 * a token streamer1 creates), which serves part of the recordings' audience and submits signed
 * receipts. Neither is a real service.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@commonair/observability";
import type { HarnessEnv } from "../../env.ts";
import { type Supervised, spawnSupervised } from "../../process.ts";
import { GoRelay, buildRelay, freePort, relayHost } from "../../relay.ts";
import type { SignedInUser } from "../../users.ts";
import { waitFor } from "../../wait.ts";

export const SINK_STREAM_KEY = "demo-seed-sink";
const RELAY_ACTIVE_TIMEOUT_MS = 60_000;

export interface RtmpSink {
  /** What the simulcast target is given (the media container's view of this machine). */
  rtmpUrl: string;
  streamKey: string;
  stop(): Promise<void>;
}

/** The sink's argv (pure): accept one RTMP publish on `port` and discard it. */
export function sinkArgs(port: number, streamKey = SINK_STREAM_KEY): string[] {
  return [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-listen",
    "1",
    "-i",
    `rtmp://0.0.0.0:${port}/live/${streamKey}`,
    "-f",
    "null",
    "-",
  ];
}

export async function startRtmpSink(env: Pick<HarnessEnv, "HARNESS_WEBHOOK_HOST">): Promise<RtmpSink> {
  const port = await freePort();
  const proc: Supervised = spawnSupervised(sinkArgs(port), { name: "seed-rtmp-sink", stopSignal: "SIGINT" });
  return {
    rtmpUrl: `rtmp://${env.HARNESS_WEBHOOK_HOST}:${port}/live`,
    streamKey: SINK_STREAM_KEY,
    stop: async () => {
      if (proc.running) await proc.stop(2_000);
    },
  };
}

export interface SeedRelay {
  relayId: string;
  stop(): Promise<void>;
}

/** streamer1 creates a relay, the harness runs it on the LAN address, and it registers as active. */
export async function startRelay(
  owner: SignedInUser,
  env: Pick<HarnessEnv, "HARNESS_API_URL">,
  log: Logger,
  signal: AbortSignal,
): Promise<SeedRelay> {
  const created = await owner.api.client.relays.create({ name: "Demo relay" });
  const binary = await buildRelay({ log });
  const dataDir = mkdtempSync(join(tmpdir(), "commonair-seed-relay-"));
  const relay = new GoRelay(
    {
      binary,
      api: env.HARNESS_API_URL,
      host: relayHost(undefined),
      port: await freePort(),
      dataDir,
      capacityMbps: 1000,
      token: created.registrationToken,
    },
    log,
  );
  const stop = async () => {
    await relay.stop();
    rmSync(dataDir, { recursive: true, force: true });
  };
  try {
    relay.start();
    await relay.waitHealthy(30_000, signal);
    await waitFor(
      "the relay active",
      async () =>
        (await owner.api.client.relays.mine()).find((r) => r.id === created.relayId)?.status === "active" || null,
      { timeoutMs: RELAY_ACTIVE_TIMEOUT_MS, intervalMs: 1_000, signal },
    );
  } catch (err) {
    await stop();
    throw new Error(`seed-media: the relay did not become active: ${String(err)} | ${relay.logs.lines(5).join(" | ")}`);
  }
  return { relayId: created.relayId, stop };
}
