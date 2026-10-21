// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Harness-owned minimal player page. It does what the real player contract requires and nothing
 * else: `playback.start` through the API, play the signed playlist (hls.js over MSE, or native HLS
 * on WebKit, mirroring Safari/iOS), heartbeat with playback stats, `playback.end` on stop. One page
 * can host several players (`count`) so many viewers share one browser context.
 *
 * Query parameters:
 *   mode=api&channel=<slug>      real playback session (default)
 *   mode=direct&src=<url>        play a playlist directly (driver tests against MediaMTX)
 *   count=<n>                    players on this page (default 1)
 *   native=auto|force|off        HLS path (auto: native on WebKit, hls.js elsewhere)
 *   ip=<addr>                    simulated client address for the harness proxy
 *   size=<w>x<h>                 rendered size of each <video> (intrinsic size is unaffected)
 *
 * Measurements come from the probe (`probe.ts`), which the harness injects into every page.
 */
import type { Contract } from "@commonair/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import Hls from "hls.js";
import { SIMULATED_IP_HEADER } from "../src/api/client.ts";
import { HUMAN_TIMING, newDeviceId, nextHeartbeatDelay } from "../src/fingerprint.ts";
import { withToken } from "../src/hls.ts";
import { PlaybackSession } from "../src/viewer.ts";
import { collectFingerprint } from "./fingerprint.ts";
import type { ProbeVideoStats } from "./probe.ts";

type Api = ContractRouterClient<Contract>;

export interface PlayerInfo {
  id: string;
  path: "mse" | "native" | null;
  sessionId: string | null;
  source: string | null;
  heartbeats: number;
  heartbeatErrors: number;
  errors: string[];
  stopped: boolean;
}

declare global {
  interface Window {
    __harness?: {
      ready: Promise<void>;
      players: PlayerInfo[];
      stopPlayer(id: string): Promise<void>;
      stop(): Promise<void>;
    };
  }
}

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "api";
const count = Math.max(1, Math.min(64, Number(params.get("count") ?? 1)));
const nativePref = params.get("native") ?? "auto";
const ip = params.get("ip");
const [vw, vh] = (params.get("size") ?? "320x180").split("x").map(Number);

const api: Api = createORPCClient(
  new RPCLink({
    url: `${location.origin}/rpc`,
    headers: () => (ip ? { [SIMULATED_IP_HEADER]: ip } : {}),
  }),
);

function isChromium(): boolean {
  return "userAgentData" in navigator || /Chrome\//.test(navigator.userAgent);
}

/** Native HLS on WebKit (Safari/iOS behaviour); hls.js everywhere MSE works. */
async function chooseNative(video: HTMLVideoElement): Promise<boolean> {
  if (nativePref === "force") return true;
  if (nativePref === "off") return false;
  const canNative = () => video.canPlayType("application/vnd.apple.mpegurl") !== "";
  if (isChromium()) return !Hls.isSupported() && canNative();
  // macOS WebKit fills its AVFoundation MIME cache off-thread; under load the first answer is "".
  for (let waited = 0; !canNative() && waited < 2_000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return canNative();
}

/** Native players do not retry a 404 playlist; wait until the live playlist exists. */
async function waitForPlaylist(url: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !signal.aborted) {
    const res = await fetch(url, { signal }).catch(() => null);
    if (res?.ok) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("playlist did not become available");
}

class Player {
  readonly info: PlayerInfo;
  readonly video: HTMLVideoElement;
  private hls: Hls | null = null;
  private session: PlaybackSession | null = null;
  private abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private bytes = { http: 0, p2p: 0 };

  constructor(id: string, container: HTMLElement) {
    this.info = {
      id,
      path: null,
      sessionId: null,
      source: null,
      heartbeats: 0,
      heartbeatErrors: 0,
      errors: [],
      stopped: false,
    };
    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    video.width = vw || 320;
    video.height = vh || 180;
    video.dataset.harnessId = id;
    container.append(video);
    this.video = video;
    window.__harnessBytes ??= {};
    window.__harnessBytes[id] = this.bytes;
  }

  async start(): Promise<void> {
    const native = await chooseNative(this.video);
    // TTFF counts from here, so a slow capability probe is not billed to playback.
    this.video.dataset.harnessStart = String(performance.now());
    this.info.path = native ? "native" : "mse";
    let url: string;
    if (mode === "direct") {
      const src = params.get("src");
      if (!src) throw new Error("mode=direct needs src");
      url = src;
    } else {
      const channel = params.get("channel");
      if (!channel) throw new Error("mode=api needs channel");
      this.session = new PlaybackSession(api, {
        channel,
        deviceId: newDeviceId(),
        nativeHls: native,
        // This page has no P2P loader; the real player (packages/player) covers P2P.
        p2pCapable: false,
        fingerprint: collectFingerprint(native),
      });
      const started = await this.session.start();
      this.info.sessionId = started.sessionId;
      this.info.source = started.source;
      url = started.playlistUrl;
      this.scheduleHeartbeat(started.heartbeatIntervalMs);
    }
    if (native) {
      await waitForPlaylist(url, this.abort.signal);
      this.video.src = url;
    } else {
      this.attachHls(url);
    }
    void this.video.play().catch(() => undefined);
  }

  private attachHls(url: string): void {
    const hls = new Hls({
      lowLatencyMode: true,
      liveSyncDurationCount: 3,
      manifestLoadingMaxRetry: 45,
      manifestLoadingRetryDelay: 1_000,
      levelLoadingMaxRetry: 10,
      fragLoadingMaxRetry: 10,
      xhrSetup: (xhr, requestUrl) => {
        // Heartbeats refresh the playback token; keep every request on the current one.
        const token = this.session?.token;
        if (token) xhr.open("GET", withToken(requestUrl, token), true);
      },
    });
    hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
      this.bytes.http += data.frag.stats.loaded;
    });
    hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => {
      this.bytes.http += data.stats.loaded;
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      this.info.errors.push(`hls.js ${data.type}: ${data.details}`);
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
    });
    hls.loadSource(url);
    hls.attachMedia(this.video);
    this.hls = hls;
  }

  private probeStats(): ProbeVideoStats | undefined {
    return window.__harnessProbe?.snapshot().find((s) => s.id === this.info.id);
  }

  private scheduleHeartbeat(intervalMs: number): void {
    this.timer = setTimeout(
      () => {
        void this.heartbeat().finally(() => {
          if (!this.info.stopped) this.scheduleHeartbeat(intervalMs);
        });
      },
      nextHeartbeatDelay(intervalMs, HUMAN_TIMING),
    );
  }

  private async heartbeat(): Promise<void> {
    if (!this.session) return;
    const s = this.probeStats();
    const v = this.video;
    const buffered = v.buffered.length > 0 ? v.buffered.end(v.buffered.length - 1) - v.currentTime : 0;
    const latest = s?.latencyMs.at(-1);
    try {
      const res = await this.session.heartbeat({
        playedSeconds: s?.playedSeconds ?? 0,
        bufferSeconds: Math.max(0, buffered),
        stalls: s?.stalls ?? 0,
        bytesHttp: this.bytes.http,
        bytesP2p: this.bytes.p2p,
        latencySeconds: latest === undefined ? null : latest / 1000,
        ttffMs: s?.ttffMs ?? null,
        visible: document.visibilityState === "visible",
        muted: v.muted,
      });
      this.info.heartbeats++;
      if (res.switchTo) this.switchTo(res.switchTo);
    } catch (err) {
      this.info.heartbeatErrors++;
      this.info.errors.push(`heartbeat: ${(err as Error).message}`);
    }
  }

  private switchTo(url: string): void {
    if (this.hls) this.hls.loadSource(url);
    else this.video.src = url;
  }

  async stop(): Promise<void> {
    if (this.info.stopped) return;
    this.info.stopped = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    this.hls?.destroy();
    this.video.removeAttribute("src");
    this.video.load();
    try {
      await this.session?.end();
    } catch (err) {
      this.info.errors.push(`end: ${(err as Error).message}`);
    }
  }
}

const container = document.getElementById("players") ?? document.body;
const players = Array.from({ length: count }, (_, i) => new Player(`p${i}`, container));
window.__harness = {
  players: players.map((p) => p.info),
  ready: Promise.all(
    players.map((p) =>
      p.start().catch((err: unknown) => {
        p.info.errors.push(`start: ${(err as Error).message}`);
      }),
    ),
  ).then(() => undefined),
  async stopPlayer(id) {
    await players.find((p) => p.info.id === id)?.stop();
  },
  async stop() {
    await Promise.all(players.map((p) => p.stop()));
  },
};
window.addEventListener("pagehide", () => {
  void window.__harness?.stop();
});
