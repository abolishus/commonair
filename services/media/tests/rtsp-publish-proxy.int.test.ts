// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The sender-report relay against the production MediaMTX config: ffmpeg publishing a rendition
 * path (`useAbsoluteTimestamp`) directly loses its first ~5 s (gortsplib drops the first sender
 * report, which arrives before the RTP packet that tells it the SSRC); through the relay MediaMTX
 * skips one copied packet per track and the path's first segment starts at the stream's start.
 * The direct publisher pins the upstream behaviour: if MediaMTX starts using the first report,
 * this test says so and the relay can go (clock/README.md, third pass).
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { internalRtspUrl } from "../src/ffmpeg/args.ts";
import { startRtspPublishProxy, type RtspPublishProxy } from "../src/ffmpeg/rtsp-publish-proxy.ts";
import { parsePlaylist } from "../src/vod/playlist.ts";
import { podmanAvailable, startMediaMtx, type Container } from "./helpers/containers.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

if (!podmanAvailable()) throw new Error("media integration tests need podman (rootless is fine)");

const run = crypto.randomUUID().slice(0, 8);
const SECRET = `relay-${run}`;
/** Fake API: allows every MediaMTX action. */
const fakeApi = Bun.serve({ port: 0, hostname: "0.0.0.0", fetch: () => new Response(null, { status: 204 }) });

let mtx: Container;
let relay: RtspPublishProxy;
const procs: Bun.Subprocess[] = [];
const basic = `Basic ${Buffer.from(`internal:${SECRET}`).toString("base64")}`;

/** Publish a 2 s-GOP test pattern with audio for `seconds`, its PTS 0 at `t0Ms`. */
function publish(url: string, t0Ms: number, seconds: number): Bun.Subprocess {
  const p = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-re",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-g",
      "60",
      "-bf",
      "0",
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-t",
      String(seconds),
      "-start_time_realtime",
      String(t0Ms * 1000),
      "-f",
      "rtsp",
      "-rtsp_transport",
      "tcp",
      "-pkt_size",
      "1200",
      url,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  procs.push(p);
  return p;
}

/**
 * PDT of the first non-gap segment of `path`'s LL-HLS, epoch ms (null until there is one). MediaMTX
 * tags PDT only after gaps and on later segments, so it is derived from the first tagged one.
 */
async function firstPdt(path: string): Promise<number | null> {
  const base = `http://127.0.0.1:${mtx.port("8888/tcp")}/${path}`;
  const index = await fetch(`${base}/index.m3u8`, { headers: { authorization: basic } }).catch(() => null);
  if (!index?.ok) return null;
  const variant = (await index.text()).split("\n").find((l) => l && !l.startsWith("#"));
  if (!variant) return null;
  const media = await fetch(`${base}/${variant}`, { headers: { authorization: basic } });
  const segments = parsePlaylist(await media.text()).segments.filter((s) => !s.uri.startsWith("gap"));
  let before = 0;
  for (const s of segments) {
    if (s.startedAt) return s.startedAt.getTime() - before;
    before += s.durationSeconds * 1000;
  }
  return null;
}

/** Poll `firstPdt` until it has a value or `deadline`. */
async function pollFirstPdt(path: string, deadline: number): Promise<number | null> {
  while (Date.now() < deadline) {
    const v = await firstPdt(path);
    if (v !== null) return v;
    await Bun.sleep(200);
  }
  return null;
}

/** "without absolute time" warnings MediaMTX logged for the session publishing `path`. */
function skipped(logs: string, path: string): number {
  const session = new RegExp(`\\[session (\\w+)\\] is publishing to path '${path.replaceAll("/", "\\/")}'`).exec(
    logs,
  )?.[1];
  if (!session) throw new Error(`no publisher session for ${path}`);
  return logs.split("\n").filter((l) => l.includes(`[session ${session}] received RTP packet without absolute time`))
    .length;
}

beforeAll(async () => {
  mtx = startMediaMtx({ apiBase: `http://host.containers.internal:${fakeApi.port}`, internalSecret: "unused" });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ok = await fetch(`http://127.0.0.1:${mtx.port("9997/tcp")}/v3/paths/list`, {
      headers: { authorization: basic },
    })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
    await Bun.sleep(250);
  }
  relay = await startRtspPublishProxy(`rtsp://127.0.0.1:${mtx.port("8554/tcp")}`);
});

afterAll(async () => {
  for (const p of procs) p.kill();
  await relay?.close();
  mtx?.stop();
  await fakeApi.stop(true);
});

describe("RTSP publish relay", () => {
  test("a rendition path keeps the publisher's first seconds only through the relay", async () => {
    const viaRelay = `live/rly_${run}/720p`;
    const direct = `live/rly_${run}/480p`;
    const t0 = Date.now();
    publish(internalRtspUrl(relay.base, viaRelay, SECRET), t0, 12);
    publish(internalRtspUrl(`rtsp://127.0.0.1:${mtx.port("8554/tcp")}`, direct, SECRET), t0, 12);

    const deadline = Date.now() + 11_000;
    const [relayPdt, directPdt] = await Promise.all([pollFirstPdt(viaRelay, deadline), pollFirstPdt(direct, deadline)]);
    const pdt = { relay: relayPdt, direct: directPdt };
    await Promise.all(procs.map((p) => p.exited));

    // Through the relay the first segment is the stream's first (W0 = t0, so PDT ≈ t0); directly,
    // nothing before the second sender report (~5 s) reaches the path.
    expect(pdt.relay).not.toBeNull();
    expect(Math.abs((pdt.relay ?? 0) - t0)).toBeLessThan(1_000);
    expect(pdt.direct).not.toBeNull();
    expect((pdt.direct ?? 0) - t0).toBeGreaterThan(4_000);

    const logs = mtx.logs();
    expect(skipped(logs, viaRelay)).toBeLessThanOrEqual(2);
    expect(skipped(logs, direct)).toBeGreaterThan(100);
  });
});
