// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The overlay alert stream (`OVERLAY_EVENTS_PATH`, SSE; docs/testing/e6-selectors.md "Alert
 * stream"). One Valkey subscriber per process: it listens to `BUS.events` and, while a channel has
 * an open overlay, to `BUS.overlay(channelId)` (test alerts and revoke signals), and fans both out
 * in memory to that channel's streams. Each stream re-checks its token on a timer, at its expiry
 * and on every revoke signal, and closes with `revoked` once the token no longer resolves.
 * The token value is never kept or logged: a stream holds only its SHA-256.
 */
import type { Valkey } from "iovalkey";
import { BUS, BusEvent } from "@commonair/contracts/events";
import { dto } from "@commonair/contracts";
import { createValkey } from "@commonair/service";
import type { Deps } from "../deps.ts";
import { alertForEvent, type AlertConfig, type OverlayAlert } from "./alerts.ts";
import { loadAlertConfigs } from "./configs.ts";
import { resolveOverlayHash, type ResolvedOverlayToken } from "./tokens.ts";

export interface OverlayHubOptions {
  /** `ping` frames keep proxies and the server's idle timeout from closing the stream. */
  pingMs: number;
  /** Token re-check interval: an expired or revoked token closes the stream within this. */
  recheckMs: number;
  maxPerChannel: number;
  maxTotal: number;
  /** Alert configs are cached this long per channel (`alerts.set` invalidates locally). */
  configTtlMs: number;
}

export const OVERLAY_HUB_DEFAULTS: OverlayHubOptions = {
  pingMs: 15_000,
  recheckMs: 20_000,
  maxPerChannel: 20,
  maxTotal: 2000,
  configTtlMs: 10_000,
};

/** setTimeout's ceiling; later expiries are caught by the periodic re-check. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const OVERLAY_PREFIX = BUS.overlay("");

interface OpenStream {
  channelId: string;
  send(event: "alert", data: OverlayAlert): void;
  recheck(): void;
  close(): void;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  "x-accel-buffering": "no",
  // The token is in the URL: never pass it on.
  "referrer-policy": "no-referrer",
};

export class OverlayHub {
  private sub: Valkey | null = null;
  private ready: Promise<unknown> | null = null;
  private readonly byChannel = new Map<string, Set<OpenStream>>();
  private total = 0;
  private readonly configs = new Map<string, { at: number; value: Promise<AlertConfig[]> }>();
  private readonly enc = new TextEncoder();

  constructor(
    private readonly deps: Deps,
    readonly opts: OverlayHubOptions = OVERLAY_HUB_DEFAULTS,
  ) {}

  /** Open streams (all channels, or one). */
  count(channelId?: string): number {
    return channelId === undefined ? this.total : (this.byChannel.get(channelId)?.size ?? 0);
  }

  invalidateConfigs(channelId: string): void {
    this.configs.delete(channelId);
  }

  private alertConfigs(channelId: string): Promise<AlertConfig[]> {
    const now = Date.now();
    const hit = this.configs.get(channelId);
    if (hit && now - hit.at < this.opts.configTtlMs) return hit.value;
    const value = loadAlertConfigs(this.deps.db, channelId);
    this.configs.set(channelId, { at: now, value });
    value.catch(() => this.configs.delete(channelId));
    return value;
  }

  private async subscriber(): Promise<Valkey> {
    if (!this.sub) {
      const sub = createValkey(this.deps.env.VALKEY_URL, { name: "api-overlay-sub" });
      sub.on("error", (err: Error) => this.deps.logger.warn("overlay subscriber error", { err: err.name }));
      sub.on("message", (channel: string, message: string) => {
        void this.onMessage(channel, message).catch((err: unknown) =>
          this.deps.logger.warn("overlay fan-out failed", { err: (err as Error).name }),
        );
      });
      this.sub = sub;
      this.ready = sub.subscribe(BUS.events);
    }
    await this.ready;
    return this.sub;
  }

  private async onMessage(channel: string, message: string): Promise<void> {
    let data: unknown;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (channel === BUS.events) {
      const ev = BusEvent.safeParse(data);
      if (!ev.success || !ev.data.channelId) return;
      const channelId = ev.data.channelId;
      if (!this.byChannel.get(channelId)?.size) return;
      const alert = alertForEvent(ev.data, channelId, await this.alertConfigs(channelId));
      if (!alert) return;
      const frame = dto.OverlayAlert.parse(alert);
      for (const s of this.byChannel.get(channelId) ?? []) s.send("alert", frame);
      return;
    }
    if (!channel.startsWith(OVERLAY_PREFIX)) return;
    const streams = this.byChannel.get(channel.slice(OVERLAY_PREFIX.length));
    if (!streams?.size) return;
    if ((data as { op?: unknown } | null)?.op === "revoke") {
      for (const s of streams) s.recheck();
      return;
    }
    const alert = dto.OverlayAlert.safeParse(data);
    if (alert.success) for (const s of streams) s.send("alert", alert.data);
  }

  private async join(s: OpenStream): Promise<void> {
    let set = this.byChannel.get(s.channelId);
    if (!set) {
      set = new Set();
      this.byChannel.set(s.channelId, set);
    }
    set.add(s);
    this.total++;
    if (set.size === 1) await (await this.subscriber()).subscribe(BUS.overlay(s.channelId));
    else await this.subscriber();
  }

  private leave(s: OpenStream): void {
    const set = this.byChannel.get(s.channelId);
    if (!set?.delete(s)) return;
    this.total--;
    if (set.size === 0) {
      this.byChannel.delete(s.channelId);
      this.sub?.unsubscribe(BUS.overlay(s.channelId)).catch(() => undefined);
    }
  }

  /** Serve one stream for a token that already resolved. `tokenHash` is re-checked, never the value. */
  async open(token: ResolvedOverlayToken, tokenHash: string, signal: AbortSignal): Promise<Response> {
    if (this.total >= this.opts.maxTotal)
      return Response.json({ code: "SERVICE_UNAVAILABLE", message: "Too many overlay streams" }, { status: 503 });
    if (this.count(token.channelId) >= this.opts.maxPerChannel)
      return Response.json(
        { code: "RATE_LIMITED", message: "Too many overlay streams for this channel" },
        { status: 429, headers: { "retry-after": "30" } },
      );

    const { deps, enc, opts } = this;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let closed = false;
    let checking = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const intervals: ReturnType<typeof setInterval>[] = [];

    const write = (chunk: string) => {
      if (closed || !controller) return;
      try {
        controller.enqueue(enc.encode(chunk));
      } catch {
        close();
      }
    };
    const close = () => {
      if (closed) return;
      closed = true;
      for (const t of timers) clearTimeout(t);
      for (const i of intervals) clearInterval(i);
      signal.removeEventListener("abort", close);
      this.leave(stream);
      try {
        controller?.close();
      } catch {
        // already closed by the client
      }
    };
    const recheck = () => {
      if (closed || checking) return;
      checking = true;
      resolveOverlayHash(deps.db, tokenHash, deps.now())
        .then((live) => {
          if (live && live.channelId === token.channelId) return;
          write("event: revoked\ndata: {}\n\n");
          close();
        })
        // Fail closed: when the token cannot be checked the stream ends and the overlay reconnects.
        .catch(() => close())
        .finally(() => {
          checking = false;
        });
    };
    const stream: OpenStream = {
      channelId: token.channelId,
      send: (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      recheck,
      close,
    };

    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(enc.encode("retry: 5000\n: connected\n\n"));
      },
      cancel: () => close(),
    });

    await this.join(stream);
    if (signal.aborted) {
      close();
      return new Response(null, { status: 499 });
    }
    signal.addEventListener("abort", close);
    intervals.push(setInterval(() => write("event: ping\ndata: {}\n\n"), opts.pingMs));
    intervals.push(setInterval(recheck, opts.recheckMs));
    if (token.expiresAt) {
      const ms = token.expiresAt.getTime() - deps.now().getTime() + 50;
      if (ms < MAX_TIMER_MS) timers.push(setTimeout(recheck, Math.max(0, ms)));
    }
    return new Response(body, { status: 200, headers: SSE_HEADERS });
  }

  async close(): Promise<void> {
    // Snapshot first: closing a stream removes it from these sets.
    const open = Array.from(this.byChannel.values(), (set) => Array.from(set)).flat();
    for (const s of open) s.close();
    const sub = this.sub;
    this.sub = null;
    this.ready = null;
    sub?.disconnect();
  }
}

const hubs = new WeakMap<Deps, OverlayHub>();

/** One hub per deps (per process), created on first use; tests may configure it first. */
export function overlayHub(deps: Deps): OverlayHub {
  let h = hubs.get(deps);
  if (!h) {
    h = new OverlayHub(deps);
    hubs.set(deps, h);
  }
  return h;
}

/** Replace the hub's timings (tests use short intervals). Closes any hub already running. */
export async function configureOverlayHub(deps: Deps, opts: Partial<OverlayHubOptions>): Promise<OverlayHub> {
  await hubs.get(deps)?.close();
  const h = new OverlayHub(deps, { ...OVERLAY_HUB_DEFAULTS, ...opts });
  hubs.set(deps, h);
  return h;
}

export async function closeOverlayHub(deps: Deps): Promise<void> {
  const h = hubs.get(deps);
  hubs.delete(deps);
  await h?.close();
}
