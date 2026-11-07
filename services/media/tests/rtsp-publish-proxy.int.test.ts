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
/**
 * How late the publishers start after the polls do: past the old 11 s poll deadline, as the relay
 * publisher was in 41761738970, so a poll bounded by the test's clock rather than by the
 * publisher fails here every time (a poll that started before the path existed got 404s only).
 */
const PUBLISH_LAG_MS = 12_000;

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
 * `onIndex` gets the multivariant playlist's HTTP status (MediaMTX answers 404 until the path has
 * a publisher, then holds the request until the muxer has content).
 */
async function firstPdt(path: string, onIndex: (status: number) => void = () => {}): Promise<number | null> {
  const base = `http://127.0.0.1:${mtx.port("8888/tcp")}/${path}`;
  const index = await fetch(`${base}/index.m3u8`, { headers: { authorization: basic } }).catch(() => null);
  onIndex(index?.status ?? 0);
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

/** When things happened for one path, ms after the test's start: what a failure reports. */
interface PathTimeline {
  spawnedMs?: number;
  /** First multivariant playlist answered 200. */
  indexOkMs?: number;
  /** Last non-200 status before that (404: no publisher yet). */
  lastIndexStatus?: number;
  pdtMs?: number;
  exitedMs?: number;
  exitCode?: number | null;
}

/**
 * Poll `firstPdt` until it has a value or the publisher has exited (its path is gone then). Not a
 * fixed deadline from the spawn: in 41761738970 the relay path had no PDT 11 s after the spawn and
 * the test ran 23 s, so a `-re -t 12` publisher was streaming until ~23 s, having started ~11 s
 * late (11.8 s on a quiet runner, 16.5 s on a busy one that passed). Such a deadline measured the
 * runner's ffmpeg start, not the relay. The first segment stays in the 7-segment window for the
 * whole 12 s run, so polling until the exit reads the same first PDT.
 */
async function pollFirstPdt(
  path: string,
  exited: Promise<unknown>,
  timeline: PathTimeline,
  since: number,
): Promise<number | null> {
  let done = false;
  void exited.then(() => (done = true));
  const onIndex = (status: number) => {
    if (status === 200) timeline.indexOkMs ??= Date.now() - since;
    else timeline.lastIndexStatus = status;
  };
  while (!done) {
    const v = await firstPdt(path, onIndex);
    if (v !== null) {
      timeline.pdtMs = Date.now() - since;
      return v;
    }
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
    // The polls start now; the publishers PUBLISH_LAG_MS later, as on a loaded runner, with PTS 0
    // at their start (`-start_time_realtime`).
    const since = Date.now();
    const t0 = since + PUBLISH_LAG_MS;
    const timelines = { relay: {} as PathTimeline, direct: {} as PathTimeline };
    const late = (url: string, tl: PathTimeline) =>
      Bun.sleep(PUBLISH_LAG_MS).then(async () => {
        tl.spawnedMs = Date.now() - since;
        const p = publish(url, t0, 12);
        tl.exitCode = await p.exited;
        tl.exitedMs = Date.now() - since;
      });
    const relayExited = late(internalRtspUrl(relay.base, viaRelay, SECRET), timelines.relay);
    const directExited = late(
      internalRtspUrl(`rtsp://127.0.0.1:${mtx.port("8554/tcp")}`, direct, SECRET),
      timelines.direct,
    );

    const [relayPdt, directPdt] = await Promise.all([
      pollFirstPdt(viaRelay, relayExited, timelines.relay, since),
      pollFirstPdt(direct, directExited, timelines.direct, since),
    ]);
    const pdt = { relay: relayPdt, direct: directPdt };
    await Promise.all([relayExited, directExited]);
    // On a failure: when each publisher started, reached MediaMTX, showed a PDT and exited.
    const seen = JSON.stringify({
      pdtMinusT0: {
        relay: relayPdt === null ? null : relayPdt - t0,
        direct: directPdt === null ? null : directPdt - t0,
      },
      timelines,
    });

    // Through the relay the first segment is the stream's first (W0 = t0, so PDT ≈ t0); directly,
    // nothing before the second sender report (~5 s) reaches the path.
    expect(pdt.relay, seen).not.toBeNull();
    expect(Math.abs((pdt.relay ?? 0) - t0), seen).toBeLessThan(1_000);
    expect(pdt.direct, seen).not.toBeNull();
    expect((pdt.direct ?? 0) - t0, seen).toBeGreaterThan(4_000);

    const logs = mtx.logs();
    expect(skipped(logs, viaRelay)).toBeLessThanOrEqual(2);
    expect(skipped(logs, direct)).toBeGreaterThan(100);
  });
});
