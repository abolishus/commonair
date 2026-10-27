// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Browser viewers: headless Playwright Chromium (hls.js over MSE) and WebKit (native HLS where
 * it has it, like Safari/iOS; Linux WebKit has none and uses hls.js too). Each page hosts one or
 * more players; every page gets the measurement probe, and well-behaved viewers also get a small init script that removes the most obvious automation
 * tells so integrity treats them like people (viewbots skip it on purpose).
 *
 * `player: "harness"` opens the harness player page; `player: "web"` opens the real web app's
 * embed route (`/embed/<channel>`, see docs/testing/e1-selectors.md). Both produce the same `Viewer` objects.
 */
import type { Logger } from "@commonair/observability";
import { type Browser, type BrowserContext, type Page, chromium, webkit } from "playwright";
import type { PlayerInfo } from "../player/player.ts";
import type { ProbeVideoStats } from "../player/probe.ts";
import type { PlayerServer } from "./player-server.ts";
import { type Viewer, type ViewerReport, type ViewerTarget, emptyReport } from "./viewer.ts";
import { P2P_NOTICE_KEY, P2P_PREFERENCE_KEY, webEmbedUrl } from "./web/selectors.ts";
import { TimeoutError, waitFor } from "./wait.ts";

export type BrowserEngine = "chromium" | "webkit";

/**
 * The path the players take in an engine, by their rule (prefersNativeHls in apps/web): native
 * only where the browser can play HLS and is not Chromium, else hls.js over MSE. WebKit can on
 * macOS; Playwright's Linux WebKit has no HLS backend.
 */
export function expectedPlaybackPath(engine: BrowserEngine, canPlayHls: boolean): "native" | "mse" {
  return canPlayHls && engine !== "chromium" ? "native" : "mse";
}

/**
 * What a player that never showed a frame got that far with, for the timeout's message: its
 * last errors, or else where it was (no session, a session but no bytes, bytes but no frame).
 * Pure.
 */
export function playerState(r: ViewerReport): string {
  const seen = r.errors.slice(-3);
  if (seen.length > 0) return `player errors: ${seen.join(" | ").slice(0, 400)}`;
  return (
    `no player errors; path=${r.playbackPath ?? "none"} session=${r.sessionId ? "yes" : "none"} ` +
    `source=${r.source ?? "none"} bytes=${r.bytesHttp} stalls=${r.stalls} heartbeats=${r.heartbeats}`
  );
}

/** Init script for well-behaved viewers: hide the webdriver flag and give headless a language list. */
export const HUMANIZE_SCRIPT = `
Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false, configurable: true });
if (!navigator.languages || navigator.languages.length === 0) {
  Object.defineProperty(Navigator.prototype, "languages", { get: () => ["en-US", "en"], configurable: true });
}
`;

/**
 * Init script for P2P viewers (P1): counts `RTCPeerConnection` constructions into
 * `window.__harnessPeerConnections`, so a scenario can prove a viewer never connected to peers.
 */
export const PEER_CONNECTION_COUNTER_SCRIPT = `
(() => {
  window.__harnessPeerConnections = 0;
  const Native = window.RTCPeerConnection;
  if (typeof Native !== "function") return;
  const Counted = function (...args) {
    window.__harnessPeerConnections++;
    return new Native(...args);
  };
  Counted.prototype = Native.prototype;
  Object.setPrototypeOf(Counted, Native);
  window.RTCPeerConnection = Counted;
})();
`;

/**
 * Init script for an opted-in P2P viewer (docs/testing/p1-selectors.md): chooses P2P and marks the
 * IP disclosure seen before the app loads, as a viewer who opted in earlier would have.
 */
export const P2P_OPT_IN_SCRIPT = `
try {
  localStorage.setItem(${JSON.stringify(P2P_PREFERENCE_KEY)}, "on");
  localStorage.setItem(${JSON.stringify(P2P_NOTICE_KEY)}, "seen");
} catch {}
`;

/** P2P mode of a web viewer: `optedIn` (storage says on) or `default` (no storage keys at all). */
export type P2PViewerMode = "optedIn" | "default";

/** What a web viewer's page says about P2P: the player's `data-p2p` and peer connections made. */
export interface P2PStatus {
  state: string | null;
  peerConnections: number;
}

export interface BrowserFleetOptions {
  headless?: boolean;
  log?: Logger;
}

/** Owns one browser process per engine for the whole run. */
export class BrowserFleet {
  private browsers = new Map<BrowserEngine, Promise<Browser>>();
  private hls = new Map<BrowserEngine, Promise<boolean>>();

  constructor(private readonly opts: BrowserFleetOptions = {}) {}

  browser(engine: BrowserEngine): Promise<Browser> {
    let b = this.browsers.get(engine);
    if (!b) {
      const type = engine === "chromium" ? chromium : webkit;
      b = type.launch({
        headless: this.opts.headless ?? true,
        args:
          engine === "chromium"
            ? [
                "--autoplay-policy=no-user-gesture-required",
                "--disable-blink-features=AutomationControlled",
                "--mute-audio",
                // P2P viewers are pages of one browser: host candidates must be real addresses,
                // not mDNS names the other pages cannot resolve.
                "--disable-features=WebRtcHideLocalIpsWithMdns",
              ]
            : [],
      });
      b.catch(() => this.browsers.delete(engine));
      this.browsers.set(engine, b);
    }
    return b;
  }

  /** Whether this engine's video element can play HLS itself, asked in the browser. */
  canPlayHls(engine: BrowserEngine): Promise<boolean> {
    let r = this.hls.get(engine);
    if (!r) {
      r = (async () => {
        const page = await (await this.browser(engine)).newPage();
        try {
          // As the player asks: macOS WebKit fills its AVFoundation MIME cache off-thread, so the
          // first answer under load can be "" (harness/player/player.ts chooseNative).
          return await page.evaluate(async () => {
            const video = document.createElement("video");
            const can = () => video.canPlayType("application/vnd.apple.mpegurl") !== "";
            for (let waited = 0; !can() && waited < 2_000; waited += 100) {
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return can();
          });
        } finally {
          await page.close();
        }
      })();
      r.catch(() => this.hls.delete(engine));
      this.hls.set(engine, r);
    }
    return r;
  }

  /** The playback path the players take in this engine (see expectedPlaybackPath). */
  async expectedPlaybackPath(engine: BrowserEngine): Promise<"native" | "mse"> {
    return expectedPlaybackPath(engine, await this.canPlayHls(engine));
  }

  async close(): Promise<void> {
    this.hls.clear();
    const all = [...this.browsers.values()];
    this.browsers.clear();
    await Promise.allSettled(all.map(async (b) => (await b).close()));
  }
}

export interface OpenBrowserViewersOptions {
  fleet: BrowserFleet;
  engine: BrowserEngine;
  target: ViewerTarget;
  /** Total viewers to open. */
  count: number;
  /** Players per page (harness player only); pages share nothing but the browser process. */
  perPage?: number;
  player?: "harness" | "web";
  /** Required for `player: "harness"`. */
  server?: PlayerServer;
  /** Required for `player: "web"`. */
  webUrl?: string;
  /** Probe script (from the player server, or `playerBundles()`). */
  probeScript: string;
  native?: "auto" | "force" | "off";
  /** Remove automation tells (default true). Viewbots pass false. */
  humanize?: boolean;
  /** Simulated client address per page. */
  clientIp?: (pageIndex: number) => string | undefined;
  /** Web player only: P2P viewers (peer-connection counter; `optedIn` also chooses P2P). */
  p2p?: P2PViewerMode;
  log?: Logger;
}

export function harnessPlayerUrl(
  base: string,
  target: ViewerTarget,
  opts: { count: number; native: string; ip?: string; size?: string },
): string {
  const u = new URL("/", base);
  if ("channel" in target) {
    u.searchParams.set("mode", "api");
    u.searchParams.set("channel", target.channel);
  } else {
    u.searchParams.set("mode", "direct");
    u.searchParams.set("src", target.playlistUrl);
  }
  u.searchParams.set("count", String(opts.count));
  u.searchParams.set("native", opts.native);
  if (opts.ip) u.searchParams.set("ip", opts.ip);
  if (opts.size) u.searchParams.set("size", opts.size);
  return u.toString();
}

class ViewerPage {
  private stoppedIds = new Set<string>();
  private closed = false;

  constructor(
    readonly page: Page,
    readonly context: BrowserContext,
    readonly playerIds: string[],
    readonly harnessPlayer: boolean,
  ) {}

  async snapshot(): Promise<{ probe: ProbeVideoStats[]; players: PlayerInfo[] }> {
    if (this.closed) return { probe: [], players: [] };
    return this.page.evaluate(() => ({
      probe: window.__harnessProbe?.snapshot() ?? [],
      players: (window.__harness?.players ?? []).map((p) => ({ ...p, errors: [...p.errors] })),
    }));
  }

  /** One click on the page: the user gesture WebKit wants before it plays (see the player). */
  async gesture(): Promise<void> {
    if (this.closed) return;
    await this.page.mouse.click(1, 1).catch(() => undefined);
  }

  async p2pStatus(): Promise<P2PStatus> {
    if (this.closed) return { state: null, peerConnections: 0 };
    return this.page.evaluate(() => ({
      state: document.querySelector('[data-testid="player"]')?.getAttribute("data-p2p") ?? null,
      peerConnections: (window as { __harnessPeerConnections?: number }).__harnessPeerConnections ?? 0,
    }));
  }

  async stopPlayer(id: string): Promise<void> {
    if (this.closed || this.stoppedIds.has(id)) return;
    this.stoppedIds.add(id);
    if (this.harnessPlayer) {
      await this.page.evaluate((pid) => window.__harness?.stopPlayer(pid), id).catch(() => undefined);
    }
    if (this.stoppedIds.size === this.playerIds.length) {
      this.closed = true;
      // Closing the context fires pagehide, which ends any sessions the page still has open.
      await this.context.close().catch(() => undefined);
    }
  }
}

/** A web viewer's P2P status (`data-p2p`, peer connections), or null for any other viewer. */
export function viewerP2PStatus(viewer: Viewer): Promise<P2PStatus> | null {
  return viewer instanceof BrowserViewer ? viewer.p2pStatus() : null;
}

class BrowserViewer implements Viewer {
  readonly kind = "browser" as const;
  private last: ViewerReport;
  private stopped = false;

  constructor(
    readonly id: string,
    private readonly engine: BrowserEngine,
    private readonly host: ViewerPage,
    private readonly playerId: string,
  ) {
    this.last = emptyReport(id, "browser", engine);
  }

  async start(): Promise<void> {
    // Pages start their players on load; nothing to do per viewer.
  }

  async report(): Promise<ViewerReport> {
    if (this.stopped) return this.last;
    const snap = await this.host.snapshot().catch((err: unknown) => {
      this.last.errors.push(`snapshot: ${(err as Error).message}`);
      return null;
    });
    if (!snap) return this.last;
    const probe =
      snap.probe.find((p) => p.id === this.playerId) ?? (this.host.harnessPlayer ? undefined : snap.probe[0]);
    const info = snap.players.find((p) => p.id === this.playerId);
    this.last = {
      ...this.last,
      playbackPath: info?.path ?? null,
      sessionId: info?.sessionId ?? null,
      source: info?.source ?? null,
      ttffMs: probe?.ttffMs ?? null,
      stalls: probe?.stalls ?? 0,
      stallMs: probe?.stallMs ?? 0,
      playedSeconds: probe?.playedSeconds ?? 0,
      latencyMs: probe?.latencyMs ?? [],
      latencyMethod: probe && probe.latencyMs.length > 0 ? "strip" : null,
      bytesHttp: probe?.bytesHttp ?? 0,
      bytesP2p: probe?.bytesP2p ?? 0,
      heartbeats: info?.heartbeats ?? 0,
      heartbeatErrors: info?.heartbeatErrors ?? 0,
      errors: [...(info?.errors ?? []), ...(probe?.errors ?? [])],
    };
    return this.last;
  }

  /** Whether the page was clicked to satisfy an autoplay refusal. */
  private gestured = false;

  async waitForFirstFrame(timeoutMs = 45_000): Promise<number> {
    try {
      return await waitFor(
        `first frame in ${this.engine} viewer ${this.id}`,
        async () => {
          const r = await this.report();
          const fatal = r.errors.find((e) => e.startsWith("start:"));
          if (fatal) throw new Error(fatal);
          // Autoplay refused: press play once, as a viewer would.
          if (!this.gestured && r.errors.some((e) => e.startsWith("play: NotAllowedError"))) {
            this.gestured = true;
            await this.host.gesture();
          }
          return r.ttffMs ?? null;
        },
        { timeoutMs, intervalMs: 250 },
      );
    } catch (err) {
      if (err instanceof TimeoutError && err.lastError instanceof Error) throw err.lastError;
      // Name what the player saw: a bare timeout says nothing about why playback never started.
      if (err instanceof TimeoutError) throw new Error(`${err.message} (${playerState(this.last)})`);
      throw err;
    }
  }

  p2pStatus(): Promise<P2PStatus> {
    return this.host.p2pStatus();
  }

  async stop(): Promise<ViewerReport> {
    if (this.stopped) return this.last;
    const final = await this.report();
    this.stopped = true;
    await this.host.stopPlayer(this.playerId);
    return final;
  }
}

/** Open `count` browser viewers of one engine. Resolves once every page has loaded. */
export async function openBrowserViewers(opts: OpenBrowserViewersOptions): Promise<Viewer[]> {
  const player = opts.player ?? "harness";
  const perPage = player === "web" ? 1 : Math.max(1, opts.perPage ?? 1);
  const browser = await opts.fleet.browser(opts.engine);
  const viewers: Viewer[] = [];
  const pages = Math.ceil(opts.count / perPage);
  for (let p = 0; p < pages; p++) {
    const onPage = Math.min(perPage, opts.count - p * perPage);
    const context = await browser.newContext({
      viewport: perPage > 1 ? { width: 1280, height: 720 } : { width: 640, height: 400 },
      locale: "en-US",
    });
    await context.addInitScript({ content: opts.probeScript });
    if (opts.humanize !== false) await context.addInitScript({ content: HUMANIZE_SCRIPT });
    if (opts.p2p) {
      if (player !== "web") throw new Error("P2P viewers need the web player");
      await context.addInitScript({ content: PEER_CONNECTION_COUNTER_SCRIPT });
      if (opts.p2p === "optedIn") await context.addInitScript({ content: P2P_OPT_IN_SCRIPT });
    }
    const page = await context.newPage();
    page.on("pageerror", (err) => opts.log?.warn("viewer page error", { engine: opts.engine, error: err.message }));
    const ip = opts.clientIp?.(p);
    let url: string;
    if (player === "harness") {
      if (!opts.server) throw new Error("harness player needs a player server");
      url = harnessPlayerUrl(opts.server.url, opts.target, {
        count: onPage,
        native: opts.native ?? "auto",
        ip,
        size: perPage > 1 ? "160x90" : "320x180",
      });
    } else {
      if (!opts.webUrl || !("channel" in opts.target)) throw new Error("web player needs webUrl and a channel target");
      url = webEmbedUrl(opts.webUrl, opts.target.channel);
    }
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const ids = Array.from({ length: onPage }, (_, i) => (player === "harness" ? `p${i}` : "v0"));
    const host = new ViewerPage(page, context, ids, player === "harness");
    for (const id of ids) viewers.push(new BrowserViewer(`${opts.engine}-${p}-${id}`, opts.engine, host, id));
  }
  return viewers;
}
