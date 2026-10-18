// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * HTTP client for MediaMTX's HLS server (never exposed publicly).
 *
 * MediaMTX 1.21 tracks HLS readers as sessions: the multivariant playlist answers
 * with URIs carrying `?session=<id>`, and every other file (media playlists,
 * segments, parts) is refused with 401 without a live session id. Sessions expire
 * after roughly 30–60 s without requests. It also bounces a cookie-less first
 * request for the multivariant playlist through `?cookieCheck=1`.
 *
 * The origin is a single reader per MediaMTX path: it holds one session per path,
 * renews it when idle, and retries once with a fresh session when MediaMTX reports
 * it gone. Clients never see session ids (rewritePlaylist strips them).
 */
import { Semaphore } from "./cache.ts";

export interface UpstreamResponse {
  status: number;
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
}

export class UpstreamError extends Error {
  override readonly name = "UpstreamError";
}

export interface UpstreamOptions {
  baseUrl: string;
  user: string;
  password: string;
  /** Timeout for ordinary requests. */
  timeoutMs?: number;
  /** Timeout for LL-HLS blocking playlist reloads, which MediaMTX holds open until the part exists. */
  blockingTimeoutMs?: number;
  maxBodyBytes?: number;
  /** Max concurrent upstream sockets. Coalescing keeps real demand far below this. */
  concurrency?: number;
  /** Renew a session that has been idle this long instead of waiting for MediaMTX to drop it. */
  sessionIdleMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Session {
  id: string;
  usedAt: number;
}

const SESSION_RE = /[?&]session=([A-Za-z0-9-]{1,64})/;

export class MediaUpstream {
  private readonly base: string;
  private readonly auth: string;
  private readonly sem: Semaphore;
  private readonly sessions = new Map<string, Session>();
  private readonly sessionInflight = new Map<string, Promise<Session | UpstreamResponse>>();
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  /** Requests actually sent to MediaMTX (tests and metrics). */
  requests = 0;

  constructor(private readonly opts: UpstreamOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.auth = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString("base64")}`;
    this.sem = new Semaphore(opts.concurrency ?? 256);
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get inFlight(): number {
    return this.sem.inUse;
  }

  /**
   * GET `<path>/<file>` from MediaMTX. `query` holds only validated LL-HLS directives.
   * Resolves with any HTTP status; rejects with UpstreamError on network failure or timeout.
   */
  async get(path: string, file: string, query = "", blocking = false): Promise<UpstreamResponse> {
    if (file === "index.m3u8") return this.multivariant(path);
    for (let attempt = 0; ; attempt++) {
      const s = await this.session(path, attempt > 0);
      if (!("id" in s)) return s;
      const qs = `session=${encodeURIComponent(s.id)}${query ? `&${query}` : ""}`;
      const res = await this.request(`${path}/${file}?${qs}`, blocking);
      if (res.status === 401 && attempt === 0) {
        // MediaMTX dropped our session (idle expiry or muxer restart): renew once.
        if (this.sessions.get(path)?.id === s.id) this.sessions.delete(path);
        continue;
      }
      if (res.status < 400) s.usedAt = this.now();
      return res;
    }
  }

  /** Forget every session (e.g. after a publisher reconnects and paths are recreated). */
  reset(path?: string): void {
    if (path) this.sessions.delete(path);
    else this.sessions.clear();
  }

  private async multivariant(path: string): Promise<UpstreamResponse> {
    const res = await this.request(`${path}/index.m3u8?cookieCheck=1`, false);
    if (res.status === 200) {
      const id = SESSION_RE.exec(new TextDecoder().decode(res.body))?.[1];
      if (id) this.sessions.set(path, { id, usedAt: this.now() });
      else this.sessions.delete(path);
    }
    return res;
  }

  private async session(path: string, forceNew: boolean): Promise<Session | UpstreamResponse> {
    const cur = this.sessions.get(path);
    const idle = this.opts.sessionIdleMs ?? 20_000;
    if (cur && !forceNew && this.now() - cur.usedAt < idle) return cur;
    let p = this.sessionInflight.get(path);
    if (!p) {
      p = this.multivariant(path)
        .then((res): Session | UpstreamResponse => {
          if (res.status !== 200) return res;
          // A 200 without a session id means MediaMTX changed its protocol: fail loudly as a bad gateway.
          return this.sessions.get(path) ?? { ...res, status: 502 };
        })
        .finally(() => this.sessionInflight.delete(path));
      this.sessionInflight.set(path, p);
    }
    return p;
  }

  private request(pathAndQuery: string, blocking: boolean): Promise<UpstreamResponse> {
    return this.sem.use(async () => {
      const timeout = blocking ? (this.opts.blockingTimeoutMs ?? 15_000) : (this.opts.timeoutMs ?? 10_000);
      const signal = AbortSignal.timeout(timeout);
      let url = `${this.base}/${pathAndQuery}`;
      try {
        for (let hop = 0; ; hop++) {
          this.requests++;
          const res = await this.doFetch(url, { headers: { authorization: this.auth }, redirect: "manual", signal });
          const location = res.headers.get("location");
          if (res.status >= 300 && res.status < 400 && location && hop === 0) {
            // Only same-origin redirects (MediaMTX's cookie check); never follow elsewhere with our credentials.
            const next = new URL(location, url);
            await res.body?.cancel();
            if (next.origin !== new URL(this.base).origin) throw new UpstreamError("cross-origin redirect refused");
            url = next.toString();
            continue;
          }
          return {
            status: res.status,
            body: await readCapped(res, this.opts.maxBodyBytes ?? 32 * 1024 * 1024),
            contentType: res.headers.get("content-type") ?? "application/octet-stream",
          };
        }
      } catch (err) {
        if (err instanceof UpstreamError) throw err;
        throw new UpstreamError(err instanceof Error ? err.message : String(err), { cause: err });
      }
    });
  }
}

async function readCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) {
    await res.body?.cancel();
    throw new UpstreamError("upstream object too large");
  }
  if (!res.body) return new Uint8Array(new ArrayBuffer(0));
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > max) throw new UpstreamError("upstream object too large");
    chunks.push(chunk);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
