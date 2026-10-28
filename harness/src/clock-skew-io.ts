// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * I/O for the `clock-skew` scenario: a sampler that follows every video rendition of a channel
 * through the origin and decodes the first frame of each new segment (PDT + strip), a VOD reader
 * doing the same over a finished VOD, and a hook that ends the recorder's ffmpeg inside the media
 * container so its supervisor starts a new run.
 *
 * The sampler is not an `HttpViewer`: that one follows only the lowest variant and keeps its
 * strip decodes to itself (`harness/src/http-viewer.ts` is shared and not ours to change). It
 * holds its own playback session, heartbeating like a player, so the origin keeps serving it.
 */
import type { Logger } from "@commonair/observability";
import type { ApiClient } from "./api/client.ts";
import type { ClockSample } from "./clock-skew.ts";
import { renditionOfUri } from "./clock-skew.ts";
import { newDeviceId, realisticFingerprint } from "./fingerprint.ts";
import { type MediaPlaylist, parsePlaylist, resolveUri, withToken } from "./hls.ts";
import { decodeStrip, graySource } from "./timestamp-strip.ts";
import { PlaybackSession } from "./viewer.ts";

const W = 320;
const H = 180;

/** First frame's strip of an fMP4 segment (init + media), or null when none decodes. */
export async function segmentStrip(init: Uint8Array | null, bytes: Uint8Array): Promise<number | null> {
  const input = init ? Buffer.concat([init, bytes]) : Buffer.from(bytes);
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-vf",
      `scale=${W}:${H}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "pipe:1",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  void proc.stdin.write(input);
  await proc.stdin.end();
  const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  if (out.byteLength < W * H) return null;
  return decodeStrip(graySource(out, W, H));
}

async function fetchBytes(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).pathname}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  return new TextDecoder().decode(await fetchBytes(url, signal));
}

interface Followed {
  url: string;
  rendition: string;
  seen: Set<string>;
  inits: Map<string, Uint8Array>;
}

export interface SamplerOptions {
  api: ApiClient;
  channel: string;
  log?: Logger;
  pollMs?: number;
}

/** Samples every video rendition the origin advertises for a live channel. */
export class RenditionSampler {
  readonly samples: (ClockSample & { seenAt: number })[] = [];
  /** Renditions in the latest multivariant playlist (video variants only). */
  current: string[] = [];
  private session: PlaybackSession;
  private readonly abort = new AbortController();
  private readonly followed = new Map<string, Followed>();
  private loops: Promise<void>[] = [];
  private decoding = 0;
  errors = 0;

  constructor(private readonly opts: SamplerOptions) {
    this.session = new PlaybackSession(opts.api, {
      channel: opts.channel,
      deviceId: newDeviceId(),
      fingerprint: realisticFingerprint(),
    });
  }

  async start(): Promise<void> {
    await this.session.start();
    this.loops.push(this.pollLoop(), this.heartbeatLoop());
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled(this.loops);
    await this.session.end().catch(() => undefined);
  }

  /** Renditions sampled since `since` (wall clock). */
  renditionsSince(since: number): string[] {
    return [...new Set(this.samples.filter((s) => s.seenAt >= since).map((s) => s.rendition))].sort();
  }

  private get playlistUrl(): string {
    const url = this.session.started?.playlistUrl ?? "";
    // Keep the origin we started on (a burst switch would move players; the sampler stays put).
    return this.session.token ? withToken(url, this.session.token) : url;
  }

  private async pollLoop(): Promise<void> {
    const signal = this.abort.signal;
    while (!signal.aborted) {
      try {
        await this.poll(signal);
      } catch (err) {
        if (signal.aborted) return;
        this.errors++;
        this.opts.log?.debug("clock sampler poll failed", { error: (err as Error).message });
      }
      await Bun.sleep(this.opts.pollMs ?? 1_000);
    }
  }

  private async heartbeatLoop(): Promise<void> {
    const signal = this.abort.signal;
    const started = Date.now();
    while (!signal.aborted) {
      await Bun.sleep(10_000);
      if (signal.aborted) return;
      await this.session
        .heartbeat({
          playedSeconds: (Date.now() - started) / 1000,
          bufferSeconds: 2,
          stalls: 0,
          bytesHttp: 0,
          bytesP2p: 0,
          latencySeconds: null,
          ttffMs: null,
          visible: true,
          muted: true,
        })
        .catch((err: unknown) =>
          this.opts.log?.debug("clock sampler heartbeat failed", { error: (err as Error).message }),
        );
    }
  }

  private async poll(signal: AbortSignal): Promise<void> {
    const top = this.playlistUrl;
    const playlist = parsePlaylist(await fetchText(top, signal));
    if (playlist.kind !== "multivariant") {
      this.current = ["source"];
      await this.follow({ url: top, rendition: "source" }, playlist, signal);
      return;
    }
    const videos = playlist.variants.filter((v) => v.resolution !== null);
    this.current = videos.map((v) => renditionOfUri(v.uri)).sort();
    await Promise.all(
      videos.map(async (v) => {
        const url = resolveUri(v.uri, top);
        const media = parsePlaylist(await fetchText(url, signal));
        if (media.kind === "media") await this.follow({ url, rendition: renditionOfUri(v.uri) }, media, signal);
      }),
    );
  }

  /** Decode every new complete segment's first frame (newest few only, bounded concurrency). */
  private async follow(t: { url: string; rendition: string }, media: MediaPlaylist, signal: AbortSignal) {
    let f = this.followed.get(t.rendition);
    if (!f) {
      f = { ...t, seen: new Set(), inits: new Map() };
      this.followed.set(t.rendition, f);
      // Start at the live edge: older segments in the first playlist are skipped.
      for (const s of media.segments.slice(0, -2)) f.seen.add(s.uri.split("?")[0] ?? s.uri);
    }
    for (const seg of media.segments) {
      const key = seg.uri.split("?")[0] ?? seg.uri;
      if (f.seen.has(key) || seg.programDateTime === null) continue;
      f.seen.add(key);
      if (this.decoding >= 6) continue;
      this.decoding++;
      try {
        let init: Uint8Array | null = null;
        if (seg.map) {
          const mapKey = seg.map.split("?")[0] ?? seg.map;
          init = f.inits.get(mapKey) ?? (await fetchBytes(resolveUri(seg.map, t.url), signal));
          f.inits.set(mapKey, init);
        }
        const bytes = await fetchBytes(resolveUri(seg.uri, t.url), signal);
        const strip = await segmentStrip(init, bytes);
        if (strip !== null)
          this.samples.push({ rendition: t.rendition, stripMs: strip, pdtMs: seg.programDateTime, seenAt: Date.now() });
      } catch (err) {
        if (!signal.aborted) this.errors++;
        this.opts.log?.debug("clock sampler segment failed", { error: (err as Error).message });
      } finally {
        this.decoding--;
      }
    }
  }
}

/** Every segment of a finished VOD playlist, decoded (bounded concurrency). */
export async function sampleVod(playlistUrl: string, signal: AbortSignal, concurrency = 4): Promise<ClockSample[]> {
  const media = parsePlaylist(await fetchText(playlistUrl, signal));
  if (media.kind !== "media") throw new Error("the VOD playlist is not a media playlist");
  const inits = new Map<string, Promise<Uint8Array>>();
  const out: ClockSample[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const seg = media.segments[next++];
      if (!seg) return;
      if (seg.programDateTime === null) continue;
      let init: Uint8Array | null = null;
      if (seg.map) {
        const url = resolveUri(seg.map, playlistUrl);
        if (!inits.has(url)) inits.set(url, fetchBytes(url, signal));
        init = await (inits.get(url) as Promise<Uint8Array>);
      }
      const strip = await segmentStrip(init, await fetchBytes(resolveUri(seg.uri, playlistUrl), signal));
      if (strip !== null) out.push({ rendition: "vod", stripMs: strip, pdtMs: seg.programDateTime });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out.sort((a, b) => a.stripMs - b.stripMs);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function podman(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["podman", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** The media service's container: compose (`…_media_1`, `…-media-1`) or Quadlet (`commonair-media`). */
export function pickMediaContainer(names: readonly string[]): string | null {
  return names.find((n) => /(^|[-_])media([-_]1)?$/.test(n)) ?? null;
}

/**
 * The shell run inside the media container: SIGTERM every process whose command line writes
 * into this broadcast's recorder directory (only the recorder's ffmpeg does), print the count.
 * No pkill in the image; /proc, tr and grep are enough.
 */
export function recorderKillScript(broadcastId: string): string {
  if (!UUID.test(broadcastId)) throw new Error("broadcast id must be a UUID");
  return [
    "n=0",
    "for p in /proc/[0-9]*; do",
    '  [ "${p#/proc/}" = "$$" ] && continue',
    `  if tr '\\0' ' ' < "$p/cmdline" 2>/dev/null | grep -q "/broadcasts/${broadcastId}/r[0-9a-z]*\\.m3u8"; then`,
    '    kill -TERM "${p#/proc/}" 2>/dev/null && n=$((n + 1))',
    "  fi",
    "done",
    'echo "$n"',
  ].join("\n");
}

/**
 * End the recorder's ffmpeg for a broadcast so its supervisor starts a new run (a recorder restart
 * mid-broadcast). Works under compose and Quadlet, where media runs in a podman container on this
 * host. Returns the container and how many processes were signalled.
 */
export async function restartRecorder(
  broadcastId: string,
  opts: { container?: string } = {},
): Promise<{ container: string; signalled: number }> {
  let container = opts.container ?? null;
  if (!container) {
    const ps = await podman(["ps", "--format", "{{.Names}}"]);
    if (ps.code !== 0) throw new Error(`podman ps failed: ${ps.stderr.trim()}`);
    container = pickMediaContainer(ps.stdout.split("\n").map((l) => l.trim()));
  }
  if (!container) throw new Error("no media container found (set --set mediaContainer=<name>)");
  const r = await podman(["exec", container, "sh", "-c", recorderKillScript(broadcastId)]);
  if (r.code !== 0) throw new Error(`podman exec ${container} failed: ${r.stderr.trim()}`);
  return { container, signalled: Number.parseInt(r.stdout.trim(), 10) || 0 };
}
