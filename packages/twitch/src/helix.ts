// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A minimal Helix client for the import (ADR 0031 decision 2): typed Zod parsers for only the
 * fields the import reads, and the four read calls. Every call is a fixed-host fetch against the
 * configured base (`TWITCH_API_BASE_URL`): no redirects, a timeout, and the rate-limit headers
 * honoured (a 429 waits for the reset once, capped). The token is the caller's; it never appears
 * in an error message.
 */
import { z } from "zod";

// Parsers: only the fields decision 2 names, plus the ids that tie them together. -------------

export const HelixUser = z.object({
  id: z.string().min(1).max(64),
  login: z.string().min(1).max(64),
  display_name: z.string().max(64),
  description: z.string().max(2000).default(""),
});
export type HelixUser = z.infer<typeof HelixUser>;
export const HelixUsersResponse = z.object({ data: z.array(HelixUser) });

export const HelixChannel = z.object({
  broadcaster_id: z.string().min(1).max(64),
  broadcaster_login: z.string().min(1).max(64),
  broadcaster_language: z.string().max(16).default(""),
  game_name: z.string().max(200).default(""),
  title: z.string().max(500).default(""),
  tags: z.array(z.string().max(100)).max(50).nullish(),
  content_classification_labels: z.array(z.string().max(100)).max(50).nullish(),
});
export type HelixChannel = z.infer<typeof HelixChannel>;
export const HelixChannelsResponse = z.object({ data: z.array(HelixChannel) });

export const HelixEmote = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  images: z.object({
    url_1x: z.url().max(2000).optional(),
    url_2x: z.url().max(2000).optional(),
    url_4x: z.url().max(2000).optional(),
  }),
  /** `"1000"`, `"2000"`, `"3000"` for subscriber emotes; empty otherwise. */
  tier: z.string().max(10).default(""),
  /** `subscriptions`, `follower`, `bitstier`, … */
  emote_type: z.string().max(40),
  format: z.array(z.string().max(20)).max(5).default(["static"]),
});
export type HelixEmote = z.infer<typeof HelixEmote>;
export const HelixEmotesResponse = z.object({
  data: z.array(HelixEmote).max(1000),
  template: z.string().max(500).optional(),
});
export type HelixEmotesResponse = z.infer<typeof HelixEmotesResponse>;

export const HelixScheduleSegment = z.object({
  start_time: z.iso.datetime({ offset: true }),
  end_time: z.iso.datetime({ offset: true }).nullish(),
  title: z.string().max(500).default(""),
  category: z.object({ name: z.string().max(200) }).nullish(),
});
export type HelixScheduleSegment = z.infer<typeof HelixScheduleSegment>;
export const HelixScheduleResponse = z.object({
  data: z.object({ segments: z.array(HelixScheduleSegment).nullish() }),
  pagination: z.object({ cursor: z.string().max(500).optional() }).optional(),
});

// The client ----------------------------------------------------------------------------------

export type HelixErrorKind = "http" | "malformed" | "network" | "rate_limited" | "host";

/** A failed Helix or OAuth call. The message never carries a token. */
export class HelixError extends Error {
  constructor(
    readonly kind: HelixErrorKind,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "HelixError";
  }
}

export interface RateLimitState {
  limit: number | null;
  remaining: number | null;
  /** Epoch milliseconds. */
  resetAt: number | null;
}

export interface FetchOptions {
  /** Test seam; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Per request, default 10 s. */
  timeoutMs?: number;
  /** Test seams for the rate-limit wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** The longest the client waits for a rate-limit reset before giving up (default 5 s). */
  maxRateLimitWaitMs?: number;
}

export interface HelixOptions extends FetchOptions {
  /** `TWITCH_API_BASE_URL`, e.g. `https://api.twitch.tv/helix`. */
  baseUrl: string;
  clientId: string;
  /** The user token from the authorization (used once, then revoked by the caller). */
  token: string;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_WAIT_MS = 5_000;
// Browser-safe (the web imports this package for `panelPaste`): no `Bun.sleep`.
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** The schedule's page size (Helix's maximum is 25). */
export const SCHEDULE_PAGE_SIZE = 25;

/** A URL under `base` (which may carry a path, as `/helix` does); refuses anything off its origin. */
export function fixedUrl(base: string, path: string, query: Record<string, string> = {}): URL {
  const root = new URL(base);
  const url = new URL(`${root.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`, root.origin);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  if (url.origin !== root.origin) throw new HelixError("host", null, "request left the configured host");
  return url;
}

export function readRateLimit(headers: Headers): RateLimitState {
  const num = (name: string) => {
    const v = headers.get(name);
    if (v === null || v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const reset = num("ratelimit-reset");
  return {
    limit: num("ratelimit-limit"),
    remaining: num("ratelimit-remaining"),
    resetAt: reset === null ? null : reset * 1000,
  };
}

/**
 * One fixed-host request with a timeout and no redirects. Retries once after a 429 when the reset
 * is close enough; returns the response for the caller to read.
 */
export async function fixedFetch(url: URL, init: RequestInit, opts: FetchOptions = {}): Promise<Response> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const maxWait = opts.maxRateLimitWaitMs ?? DEFAULT_MAX_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      throw new HelixError("network", null, `request failed: ${err instanceof Error ? err.name : "error"}`);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      throw new HelixError("host", res.status, "redirects are not followed");
    }
    if (res.status !== 429) return res;
    await res.body?.cancel().catch(() => {});
    const { resetAt } = readRateLimit(res.headers);
    const wait = resetAt === null ? 1_000 : Math.max(0, resetAt - now());
    if (attempt >= 1 || wait > maxWait) throw new HelixError("rate_limited", 429, "rate limited");
    await sleep(wait);
  }
}

async function readJson<T>(res: Response, schema: z.ZodType<T>, what: string): Promise<T> {
  const body: unknown = await res.json().catch(() => undefined);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HelixError("malformed", res.status, `${what}: malformed response`);
  return parsed.data;
}

export class HelixClient {
  /** The rate-limit headers of the latest answer. */
  rateLimit: RateLimitState = { limit: null, remaining: null, resetAt: null };

  constructor(private readonly opts: HelixOptions) {}

  private async get<T>(path: string, query: Record<string, string>, schema: z.ZodType<T>): Promise<T | null> {
    const now = this.opts.now ?? Date.now;
    // Out of budget: wait for the reset (capped) rather than spend a request on a 429.
    if (this.rateLimit.remaining === 0 && this.rateLimit.resetAt !== null) {
      const wait = this.rateLimit.resetAt - now();
      if (wait > (this.opts.maxRateLimitWaitMs ?? DEFAULT_MAX_WAIT_MS))
        throw new HelixError("rate_limited", null, "rate limited");
      if (wait > 0) await (this.opts.sleep ?? defaultSleep)(wait);
    }
    const res = await fixedFetch(
      fixedUrl(this.opts.baseUrl, path, query),
      {
        method: "GET",
        headers: {
          "client-id": this.opts.clientId,
          authorization: `Bearer ${this.opts.token}`,
          accept: "application/json",
        },
      },
      this.opts,
    );
    this.rateLimit = readRateLimit(res.headers);
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new HelixError("http", res.status, `${path} answered ${res.status}`);
    }
    return readJson(res, schema, path);
  }

  /** `GET /users` with the user token: the authorized user. */
  async me(): Promise<HelixUser> {
    const r = await this.get("users", {}, HelixUsersResponse);
    const u = r?.data[0];
    if (!u || (r?.data.length ?? 0) !== 1) throw new HelixError("malformed", 200, "users: expected one user");
    return u;
  }

  /** `GET /channels?broadcaster_id=`. */
  async channel(broadcasterId: string): Promise<HelixChannel> {
    const r = await this.get("channels", { broadcaster_id: broadcasterId }, HelixChannelsResponse);
    const c = r?.data[0];
    if (!c) throw new HelixError("malformed", 200, "channels: no channel");
    return c;
  }

  /** `GET /chat/emotes?broadcaster_id=` (one page; Helix does not paginate it). */
  async emotes(broadcasterId: string): Promise<HelixEmotesResponse> {
    return (await this.get("chat/emotes", { broadcaster_id: broadcasterId }, HelixEmotesResponse)) ?? { data: [] };
  }

  /** `GET /schedule?broadcaster_id=`, every page up to `max` segments. A channel with none answers 404: empty. */
  async schedule(broadcasterId: string, max: number): Promise<HelixScheduleSegment[]> {
    const out: HelixScheduleSegment[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50 && out.length < max; page++) {
      const query: Record<string, string> = { broadcaster_id: broadcasterId, first: String(SCHEDULE_PAGE_SIZE) };
      if (after) query.after = after;
      const r = await this.get("schedule", query, HelixScheduleResponse);
      if (!r) break;
      out.push(...(r.data.segments ?? []));
      const next = r.pagination?.cursor;
      if (!next || next === after || (r.data.segments ?? []).length === 0) break;
      after = next;
    }
    return out.slice(0, max);
  }
}
