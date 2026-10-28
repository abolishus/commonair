// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The running stack as the harness sees it: URLs, typed API clients (one cookie jar and one
 * simulated address per user, through the forwarding proxy), user signup, streamers, viewers,
 * bots and the shared browser fleet. Shared resources start lazily and close in `close()`.
 */
import type { Logger } from "@commonair/observability";
import { existsSync } from "node:fs";
import { chromium, webkit } from "playwright";
import { type Api, createApi } from "./api/client.ts";
import { CookieJar } from "./api/cookies.ts";
import { TmiBot } from "./bots/tmi-bot.ts";
import { SdkBot, createContractSdk } from "./bots/sdk-bot.ts";
import { type BrowserEngine, BrowserFleet, openBrowserViewers } from "./browser-viewer.ts";
import { ChatClient } from "./chat-client.ts";
import { AddressPool, DATACENTER_CIDRS_FILE, RESIDENTIAL_CIDRS_FILE, loadCidrList, seededRandom } from "./cidrs.ts";
import type { HarnessEnv } from "./env.ts";
import { probeFfmpeg, whipFfmpeg } from "./ffmpeg.ts";
import type { HeartbeatTiming } from "./fingerprint.ts";
import { HttpViewer } from "./http-viewer.ts";
import { Mailpit, mailpitEndpoint } from "./mailpit.ts";
import { type PlayerServer, startPlayerServer } from "./player-server.ts";
import { podmanAvailable } from "./testing/mediamtx.ts";
import { type ForwardingProxy, startForwardingProxy, startTrackerProxy } from "./proxy.ts";
import { relayReadiness } from "./relay.ts";
import type { Need } from "./scenario.ts";
import { type StreamerOptions, Streamer, rtmpPublishUrl, whipPublishTarget } from "./streamer.ts";
import { type SignUpOptions, type SignedInUser, UserFactory, UsernameFactory } from "./users.ts";
import type { Viewer } from "./viewer.ts";
import { waitFor } from "./wait.ts";

export interface ViewerMix {
  chromium?: number;
  webkit?: number;
  http?: number;
  /** Browser players per page (default 1). */
  perPage?: number;
  /** Decode the strip in HTTP viewers every N segments (0 = PDT latency only). */
  httpStripEvery?: number;
  /**
   * Heartbeat timing of the HTTP viewers (default `HUMAN_TIMING`, which now and then sends a beat
   * late enough to drop out of the 30 s count window: use `STEADY_TIMING` to hold a count exact).
   */
  httpTiming?: HeartbeatTiming;
  /**
   * P1: web Chromium viewers, whatever HARNESS_PLAYER says. `optedIn` chose P2P (storage set
   * before load) and reach the tracker through the harness tracker proxy; `atDefault` have no
   * storage keys at all, like a first-time visitor (the operator default applies).
   */
  p2p?: { optedIn: number; atDefault: number };
}

/** True when a TCP connection to host:port succeeds within `timeoutMs`. */
export async function tcpReachable(hostname: string, port: number, timeoutMs = 3_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const socket = await Promise.race([
      Bun.connect({ hostname, port, socket: { data: () => undefined } }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    socket.end();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class Platform {
  readonly names: UsernameFactory;
  readonly residential: AddressPool;
  readonly datacenter: AddressPool;
  readonly mailpit: Mailpit;
  readonly users: UserFactory;
  private proxy: ForwardingProxy | null = null;
  private trackerProxy: ForwardingProxy | null = null;
  private playerServerPromise: Promise<PlayerServer> | null = null;
  private fleetInstance: BrowserFleet | null = null;
  private probes = new Map<Need, Promise<string | null>>();

  constructor(
    readonly env: HarnessEnv,
    readonly log: Logger,
    readonly runId: string,
  ) {
    const seed = Number.parseInt(runId.replace(/[^0-9a-f]/gi, "").slice(0, 8) || "1", 16);
    this.names = new UsernameFactory(runId.slice(-5));
    this.residential = new AddressPool(
      loadCidrList(env.HARNESS_RESIDENTIAL_CIDRS_FILE ?? RESIDENTIAL_CIDRS_FILE),
      seededRandom(seed),
    );
    this.datacenter = new AddressPool(
      loadCidrList(env.HARNESS_DATACENTER_CIDRS_FILE ?? DATACENTER_CIDRS_FILE),
      seededRandom(seed ^ 0x5bd1e995),
    );
    this.mailpit = new Mailpit(env.HARNESS_MAILPIT_URL, env.HARNESS_MAILPIT_AUTH);
    this.users = new UserFactory({
      apiUrl: env.HARNESS_API_URL,
      webOrigin: new URL(env.HARNESS_WEB_URL).origin,
      mailpitUrl: env.HARNESS_MAILPIT_URL,
      mailpitAuth: env.HARNESS_MAILPIT_AUTH,
      emailDomain: env.HARNESS_EMAIL_DOMAIN,
      names: this.names,
      apiFactory: (o) => this.api({ clientIp: o.clientIp, jar: o.jar, bearer: o.bearer, userAgent: o.userAgent }),
    });
  }

  /** Base URL simulated clients use for the API: the forwarding proxy. */
  apiBaseUrl(): string {
    this.proxy ??= startForwardingProxy({ target: this.env.HARNESS_API_URL });
    return this.proxy.url;
  }

  /** A fresh API client. Each call is a new simulated client (own jar, own address unless given). */
  api(opts: { clientIp?: string; jar?: CookieJar; bearer?: string; userAgent?: string } = {}): Api {
    return createApi({
      baseUrl: this.apiBaseUrl(),
      origin: new URL(this.env.HARNESS_WEB_URL).origin,
      jar: opts.jar ?? new CookieJar(),
      bearer: opts.bearer,
      clientIp: opts.clientIp ?? this.residential.next(),
      userAgent: opts.userAgent,
    });
  }

  signUp(opts: SignUpOptions = {}): Promise<SignedInUser> {
    return this.users.signUp({ clientIp: this.residential.next(), ...opts });
  }

  get fleet(): BrowserFleet {
    this.fleetInstance ??= new BrowserFleet({ headless: !this.env.HARNESS_HEADFUL, log: this.log });
    return this.fleetInstance;
  }

  playerServer(): Promise<PlayerServer> {
    this.playerServerPromise ??= startPlayerServer({ apiUrl: this.apiBaseUrl() });
    return this.playerServerPromise;
  }

  /** Rotate the user's stream key and build a streamer for it (not started). */
  async streamerFor(
    user: SignedInUser,
    opts: Partial<StreamerOptions> & { protocol: "rtmp" | "whip" },
  ): Promise<Streamer> {
    const channel = user.me.channelSlug ?? user.username;
    const { key } = await user.api.client.stream.rotateKey({ channel });
    const target =
      opts.protocol === "rtmp"
        ? { url: rtmpPublishUrl(this.env.HARNESS_RTMP_URL, key) }
        : whipPublishTarget(this.env.HARNESS_WHIP_URL, key);
    return new Streamer({ name: `streamer-${channel}`, log: this.log, ...opts, ...target });
  }

  /** Wait until `channels.get` reports the channel live (or offline). Returns elapsed ms. */
  async waitForLive(channel: string, live = true, timeoutMs = 30_000): Promise<number> {
    const started = Date.now();
    const anon = this.api();
    await waitFor(
      `${channel} ${live ? "live" : "offline"}`,
      async () => {
        const c = await anon.client.channels.get({ channel });
        return (c.live !== null) === live;
      },
      { timeoutMs, intervalMs: 500 },
    );
    return Date.now() - started;
  }

  async viewerCount(channel: string): Promise<number | null> {
    const c = await this.api().client.channels.get({ channel });
    return c.live?.viewerCount ?? null;
  }

  /** Open a mix of browser and HTTP viewers on a channel; all are started, none awaited for frames. */
  async openViewers(channel: string, mix: ViewerMix): Promise<Viewer[]> {
    const viewers: Viewer[] = [];
    const player = this.env.HARNESS_PLAYER;
    for (const engine of ["chromium", "webkit"] as const satisfies BrowserEngine[]) {
      const count = mix[engine] ?? 0;
      if (count === 0) continue;
      const server = player === "harness" ? await this.playerServer() : undefined;
      const probeScript =
        server?.probeScript ?? (await import("./player-server.ts").then((m) => m.playerBundles())).probe;
      viewers.push(
        ...(await openBrowserViewers({
          fleet: this.fleet,
          engine,
          target: { channel },
          count,
          perPage: mix.perPage,
          player,
          server,
          webUrl: this.env.HARNESS_WEB_URL,
          probeScript,
          clientIp: () => this.residential.next(),
          log: this.log,
        })),
      );
    }
    if (mix.p2p) viewers.push(...(await this.openP2PViewers(channel, mix.p2p)));
    const http = Array.from(
      { length: mix.http ?? 0 },
      () =>
        new HttpViewer({
          target: { channel },
          api: this.api().client,
          decodeStripEvery: mix.httpStripEvery ?? 0,
          ...(mix.httpTiming ? { timing: mix.httpTiming } : {}),
          log: this.log,
        }),
    );
    // Stagger HTTP starts a little, like an audience arriving.
    for (const v of http) {
      await v.start();
      viewers.push(v);
      await Bun.sleep(20 + Math.random() * 60);
    }
    return viewers;
  }

  /**
   * The tracker proxy on its fixed port (harness/compose.p2p.yaml points the API's
   * P2P_TRACKER_URL at it): each session reaches the tracker from its own residential /24.
   */
  trackerProxyUrl(): string {
    this.trackerProxy ??= startTrackerProxy({
      target: this.env.HARNESS_TRACKER_URL,
      port: this.env.HARNESS_TRACKER_PROXY_PORT,
      cidrs: this.residential.cidrs,
    });
    return this.trackerProxy.url;
  }

  private async openP2PViewers(channel: string, p2p: NonNullable<ViewerMix["p2p"]>): Promise<Viewer[]> {
    if (p2p.optedIn > 0) this.trackerProxyUrl();
    const { probe } = await import("./player-server.ts").then((m) => m.playerBundles());
    const open = (count: number, mode: "optedIn" | "default") =>
      count === 0
        ? Promise.resolve([])
        : openBrowserViewers({
            fleet: this.fleet,
            engine: "chromium",
            target: { channel },
            count,
            player: "web",
            webUrl: this.env.HARNESS_WEB_URL,
            probeScript: probe,
            p2p: mode,
            log: this.log,
          });
    return [...(await open(p2p.optedIn, "optedIn")), ...(await open(p2p.atDefault, "default"))];
  }

  /** Chat client for a signed-in user (or anonymous when `user` is omitted). */
  chat(user?: SignedInUser): Promise<ChatClient> {
    return ChatClient.connectWithApi((user?.api ?? this.api()).client, this.log);
  }

  /** Create a bot account owned by `owner` and mint it a chat token. */
  async createBot(owner: SignedInUser, prefix = "bot"): Promise<{ id: string; username: string; token: string }> {
    const username = this.names.next(prefix);
    const bot = await owner.api.client.me.bots.create({ username, displayName: username });
    const { accessToken } = await owner.api.client.me.bots.createToken({
      botId: bot.id,
      scopes: ["chat:read", "chat:edit"],
      expiresInDays: 1,
    });
    return { id: bot.id, username: bot.username, token: accessToken };
  }

  sdkBot(bot: { id: string; token: string }, channels: string[]): SdkBot {
    const sdk = createContractSdk({ apiUrl: this.env.HARNESS_API_URL, token: bot.token, log: this.log });
    return new SdkBot({ sdk, botUserId: bot.id, channels, log: this.log });
  }

  tmiBot(bot: { username: string; token: string }, channels: string[]): TmiBot {
    const anon = this.api();
    return new TmiBot({
      url: this.env.HARNESS_IRC_WS_URL,
      username: bot.username,
      token: bot.token,
      channels,
      log: this.log,
      liveSince: async (channel) => {
        const c = await anon.client.channels.get({ channel }).catch(() => null);
        return c?.live ? Date.parse(c.live.startedAt) : null;
      },
    });
  }

  /** Probe one need; resolves to null when met, else the reason it is not. Cached per run. */
  probe(need: Need): Promise<string | null> {
    let p = this.probes.get(need);
    if (!p) {
      p = this.runProbe(need).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
      this.probes.set(need, p);
    }
    return p;
  }

  private async runProbe(need: Need): Promise<string | null> {
    const http = async (url: string, what: string) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) }).catch(() => null);
      return res && res.status < 500 ? null : `${what} unreachable at ${new URL(url).origin}`;
    };
    const e = this.env;
    switch (need) {
      case "api":
        return http(`${e.HARNESS_API_URL}/healthz`, "API");
      case "web": {
        // The web app answers 200 on /healthz (docs/testing/e1-selectors.md); anything else on the
        // port (a 404 from another server) does not count.
        const url = new URL("/healthz", e.HARNESS_WEB_URL);
        const res = await fetch(url, { signal: AbortSignal.timeout(3_000) }).catch(() => null);
        if (!res) return `web app unreachable at ${url.origin}`;
        return res.ok ? null : `web app /healthz answered HTTP ${res.status} at ${url.origin}`;
      }
      case "chat":
        return http(e.HARNESS_CHAT_HEALTH_URL, "chat service");
      case "irc":
        return http(e.HARNESS_IRC_HEALTH_URL, "IRC gateway");
      case "origin":
        return http(`${e.HARNESS_ORIGIN_URL}/healthz`, "origin");
      case "media": {
        // MediaMTX ingest: its RTMP listener accepts TCP connections.
        const rtmp = new URL(e.HARNESS_RTMP_URL);
        return (await tcpReachable(rtmp.hostname, Number(rtmp.port || 1935)))
          ? null
          : `MediaMTX RTMP ingest unreachable at ${rtmp.host}`;
      }
      case "worker":
        return http(e.HARNESS_WORKER_HEALTH_URL, "worker");
      case "relay":
        // Go to build relay/, and an API that accepts LAN (private, http) relay URLs.
        return relayReadiness({ ...process.env, HARNESS_API_URL: e.HARNESS_API_URL });
      case "mail":
        return (await this.mailpit.ping())
          ? null
          : `Mailpit unreachable at ${mailpitEndpoint(e.HARNESS_MAILPIT_URL).url} (protected? set HARNESS_MAILPIT_AUTH)`;
      case "stripe":
        return http(e.HARNESS_STRIPE_MOCK_URL, "stripe-mock");
      case "oauth": {
        const info = await this.api().client.instance.info();
        return info.features.oauthProviders.length > 0 ? null : "no OAuth providers configured";
      }
      case "cdn": {
        const info = await this.api().client.instance.info();
        return info.features.cdn ? null : "CDN origin-pull disabled";
      }
      case "ffmpeg":
        await probeFfmpeg();
        return null;
      case "whip":
        return (await whipFfmpeg()) ? null : "no ffmpeg with a WHIP muxer (local, or the pinned image through podman)";
      case "browser": {
        const missing = [
          ["chromium", chromium.executablePath()],
          ["webkit", webkit.executablePath()],
        ].filter(([, path]) => !path || !existsSync(path));
        return missing.length === 0
          ? null
          : `Playwright browsers missing (${missing.map(([n]) => n).join(", ")}): run bun run --filter @commonair/harness browsers`;
      }
      case "prometheus":
        return e.HARNESS_PROMETHEUS_URL
          ? http(`${e.HARNESS_PROMETHEUS_URL}/-/ready`, "Prometheus")
          : "HARNESS_PROMETHEUS_URL not set";
      case "podman":
        return (await podmanAvailable()) ? null : "podman not available";
    }
  }

  async close(): Promise<void> {
    await this.fleetInstance?.close();
    this.fleetInstance = null;
    const server = this.playerServerPromise;
    this.playerServerPromise = null;
    if (server) await (await server).stop().catch(() => undefined);
    await this.proxy?.stop();
    this.proxy = null;
    await this.trackerProxy?.stop();
    this.trackerProxy = null;
  }
}
