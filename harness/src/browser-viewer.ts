// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Browser viewers: headless Playwright Chromium (hls.js over MSE) and WebKit (native HLS, like
 * Safari/iOS). Each page hosts one or more players; every page gets the measurement probe, and
 * well-behaved viewers also get a small init script that removes the most obvious automation
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
import { webEmbedUrl } from "./web/selectors.ts";
import { TimeoutError, waitFor } from "./wait.ts";

export type BrowserEngine = "chromium" | "webkit";

/** Init script for well-behaved viewers: hide the webdriver flag and give headless a language list. */
export const HUMANIZE_SCRIPT = `
Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false, configurable: true });
if (!navigator.languages || navigator.languages.length === 0) {
  Object.defineProperty(Navigator.prototype, "languages", { get: () => ["en-US", "en"], configurable: true });
}
`;

export interface BrowserFleetOptions {
  headless?: boolean;
  log?: Logger;
}

/** Owns one browser process per engine for the whole run. */
export class BrowserFleet {
  private browsers = new Map<BrowserEngine, Promise<Browser>>();

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
              ]
            : [],
      });
      b.catch(() => this.browsers.delete(engine));
      this.browsers.set(engine, b);
    }
    return b;
  }

  async close(): Promise<void> {
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
      const seen = this.last.errors.slice(-3);
      if (err instanceof TimeoutError && seen.length > 0)
        throw new Error(`${err.message} (player errors: ${seen.join(" | ").slice(0, 400)})`);
      throw err;
    }
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
