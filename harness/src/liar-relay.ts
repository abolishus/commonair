// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An over-reporting member relay, in TypeScript (e3-selectors step 5). It speaks the relay
 * protocol like the Go relay (`/api/relay/register`, `/heartbeat`, `/receipts` with its bearer
 * token) and really serves its assigned viewers: `/hls/<path>?t=<token>` is pulled from the
 * origin's `/relay-pull/` and playlists are rewritten so every URI carries the viewer token. The
 * origin's issuance for it therefore accrues honestly, while its receipts are correctly signed
 * but claim `factor` × the media bytes it served, which the worker must reject.
 */
import type { ReceiptPayload } from "@commonair/contracts";
import type { Logger } from "@commonair/observability";
import {
  type SignedReceipt,
  type SigningKey,
  generateSigningKey,
  importVerifyKey,
  randomSecret,
  signReceipt,
  verifyPlaybackToken,
} from "@commonair/tokens";
import { LineLog } from "./relay.ts";
import { sleep } from "./wait.ts";

export const LIAR_FACTOR = 5;
export const LIAR_VERSION = "harness-liar";

/** Media bytes and complete segments served to one session in the current period. */
export interface Tally {
  bytes: number;
  segments: number;
}

/** Same path alphabet as the Go relay (`hls.ValidPath`). */
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,7}$/;

export function validHlsPath(p: string): boolean {
  return p.length <= 512 && PATH_RE.test(p) && !p.includes("..");
}

function withT(uri: string, token: string): string {
  if (/[?&]t=/.test(uri)) return uri;
  return `${uri}${uri.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`;
}

/**
 * The origin's relay-pull playlists use relative URIs without tokens; add the viewer's token to
 * every URI line and `URI="…"` attribute so players (hls.js too) come back to this relay with it.
 */
export function tokenizePlaylist(body: string, token: string): string {
  return body
    .split("\n")
    .map((raw) => {
      const line = raw.replace(/\r$/, "");
      if (line === "") return line;
      if (line.startsWith("#"))
        return line.replace(/URI="([^"]*)"/g, (_m, uri: string) => `URI="${withT(uri, token)}"`);
      return withT(line, token);
    })
    .join("\n");
}

/** Start of the UTC minute containing `ms` (issuance is bucketed per minute). */
export function minuteFloor(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

/** Entries for a period: `factor` × the served bytes; segments are reported as served. */
export function inflatedEntries(
  served: ReadonlyMap<string, Tally>,
  assigned: Iterable<string>,
  factor: number,
): ReceiptPayload["entries"] {
  const ids = new Set([...served.keys(), ...assigned]);
  return [...ids].sort().map((sessionId) => {
    const t = served.get(sessionId) ?? { bytes: 0, segments: 0 };
    return { sessionId, segments: t.segments, bytes: Math.round(t.bytes * factor) };
  });
}

/** A correctly signed receipt that over-reports. */
export async function buildLiarReceipt(
  key: SigningKey,
  relayId: string,
  period: { start: Date; end: Date },
  served: ReadonlyMap<string, Tally>,
  assigned: Iterable<string> = [],
  factor = LIAR_FACTOR,
): Promise<{ payload: ReceiptPayload; receipt: SignedReceipt }> {
  const payload: ReceiptPayload = {
    v: 1,
    relayId,
    nonce: randomSecret("", 18),
    periodStart: period.start.toISOString(),
    periodEnd: period.end.toISOString(),
    entries: inflatedEntries(served, assigned, factor),
  };
  return { payload, receipt: await signReceipt(key, payload) };
}

interface RegisterResponse {
  relayId: string;
  originUrl: string;
  originPublicKey: string;
  receiptIntervalSeconds: number;
  heartbeatIntervalSeconds: number;
  status: string;
}

export interface LiarRelayOptions {
  /** Instance API base (the relay protocol lives under `/api/relay/*`). */
  apiUrl: string;
  token: string;
  /** LAN address the API container and the viewers reach. */
  host: string;
  port: number;
  factor?: number;
  log?: Logger;
  /** For tests: shorter receipt periods than the API's interval. */
  receiptIntervalMs?: number;
}

export interface LiarReceiptRecord {
  at: string;
  periodStart: string;
  periodEnd: string;
  sessions: number;
  bytesServed: number;
  bytesClaimed: number;
  receiptId: string | null;
  status: string | null;
  error?: string;
}

export class LiarRelay {
  readonly logs = new LineLog();
  readonly receipts: LiarReceiptRecord[] = [];
  /** Total media bytes actually served, per session (whole run). */
  readonly servedTotal = new Map<string, Tally>();
  status: string | null = null;
  relayId: string | null = null;
  private key: SigningKey | null = null;
  private originKey: CryptoKey | null = null;
  private registration: RegisterResponse | null = null;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private period = new Map<string, Tally>();
  private periodStart = Date.now();
  private readonly assigned = new Set<string>();
  private readonly lastSeen = new Map<string, number>();
  private readonly abort = new AbortController();
  private loops: Promise<void>[] = [];
  private egressBytes = 0;

  constructor(private readonly opts: LiarRelayOptions) {}

  get url(): string {
    return `http://${this.opts.host}:${this.opts.port}`;
  }

  /** Sessions the harness knows the API assigned to this relay (added to every receipt). */
  assign(sessionIds: Iterable<string>): void {
    for (const id of sessionIds) this.assigned.add(id);
  }

  /** Serve `/healthz` + `/hls/`, then register (the API health-checks us while registering). */
  async start(): Promise<RegisterResponse> {
    this.key = (await generateSigningKey()).key;
    this.server = Bun.serve({ hostname: "0.0.0.0", port: this.opts.port, fetch: (req) => this.handle(req) });
    const reg = await this.call<RegisterResponse>("register", {
      publicUrl: this.url,
      declaredCapacityMbps: 1000,
      publicKey: this.key.publicKeyB64,
      version: LIAR_VERSION,
      region: "",
    });
    this.registration = reg;
    this.relayId = reg.relayId;
    this.status = reg.status;
    this.originKey = await importVerifyKey(reg.originPublicKey);
    this.periodStart = Date.now();
    this.note(`registered ${reg.relayId} status ${reg.status}`);
    this.loops.push(this.heartbeatLoop(), this.receiptLoop());
    return reg;
  }

  private note(line: string): void {
    this.logs.push("liar", line);
    this.opts.log?.info("liar relay", { event: line });
  }

  private async call<T>(what: "register" | "heartbeat" | "receipts", body: unknown): Promise<T> {
    const res = await fetch(`${this.opts.apiUrl.replace(/\/+$/, "")}/api/relay/${what}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        "content-type": "application/json",
        "user-agent": `commonair-relay/${LIAR_VERSION}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      const hint =
        what === "register" && res.status === 400 && text.includes("publicUrl")
          ? " (is OUTBOUND_ALLOW_PRIVATE_NETWORKS=true set for the API, and is the LAN address reachable from it?)"
          : "";
      throw new Error(`relay ${what}: HTTP ${res.status} ${text.slice(0, 300)}${hint}`);
    }
    return JSON.parse(text) as T;
  }

  private async heartbeatLoop(): Promise<void> {
    const everyMs = (this.registration?.heartbeatIntervalSeconds ?? 15) * 1000;
    let last = Date.now();
    while (!this.abort.signal.aborted) {
      await sleep(everyMs, this.abort.signal).catch(() => undefined);
      if (this.abort.signal.aborted) return;
      const now = Date.now();
      const mbps = (this.egressBytes * 8) / 1e6 / Math.max(1, (now - last) / 1000);
      this.egressBytes = 0;
      last = now;
      try {
        const r = await this.call<{ status: string }>("heartbeat", {
          activeViewers: this.viewers(),
          egressMbps: Math.round(mbps * 100) / 100,
          cacheBytes: 0,
        });
        if (r.status !== this.status) this.note(`status ${this.status} -> ${r.status}`);
        this.status = r.status;
      } catch (err) {
        this.note(`heartbeat failed: ${(err as Error).message}`);
      }
    }
  }

  /** Cut a period at each interval boundary (minute-aligned by default) and submit the lie. */
  private async receiptLoop(): Promise<void> {
    const intervalMs = this.opts.receiptIntervalMs ?? (this.registration?.receiptIntervalSeconds ?? 60) * 1000;
    while (!this.abort.signal.aborted) {
      const now = Date.now();
      const boundary = this.opts.receiptIntervalMs === undefined ? minuteFloor(now) + intervalMs : now + intervalMs;
      // A little after the boundary, like the Go relay, so the period is closed.
      await sleep(boundary - now + 1_000, this.abort.signal).catch(() => undefined);
      if (this.abort.signal.aborted) return;
      await this.submitPeriod(this.opts.receiptIntervalMs === undefined ? boundary : Date.now());
    }
  }

  /** Close the current period at `endMs` and submit its receipt (skipped when nothing was served). */
  async submitPeriod(endMs = Date.now()): Promise<LiarReceiptRecord | null> {
    const key = this.key;
    const relayId = this.relayId;
    if (!key || !relayId) return null;
    const served = this.period;
    const start = new Date(this.periodStart);
    const end = new Date(Math.max(endMs, this.periodStart + 1));
    this.period = new Map();
    this.periodStart = end.getTime();
    const bytesServed = [...served.values()].reduce((s, t) => s + t.bytes, 0);
    if (bytesServed === 0) return null;
    const { payload, receipt } = await buildLiarReceipt(
      key,
      relayId,
      { start, end },
      served,
      this.assigned,
      this.opts.factor ?? LIAR_FACTOR,
    );
    const record: LiarReceiptRecord = {
      at: new Date().toISOString(),
      periodStart: payload.periodStart,
      periodEnd: payload.periodEnd,
      sessions: payload.entries.length,
      bytesServed,
      bytesClaimed: payload.entries.reduce((s, e) => s + e.bytes, 0),
      receiptId: null,
      status: null,
    };
    try {
      const r = await this.call<{ receiptId: string; status: string }>("receipts", receipt);
      record.receiptId = r.receiptId;
      record.status = r.status;
    } catch (err) {
      record.error = (err as Error).message;
    }
    this.receipts.push(record);
    this.note(
      `receipt ${record.receiptId ?? "refused"}: served ${bytesServed} claimed ${record.bytesClaimed}${record.error ? ` (${record.error})` : ""}`,
    );
    return record;
  }

  /** Sessions seen in the last minute. */
  viewers(now = Date.now()): number {
    let n = 0;
    for (const at of this.lastSeen.values()) if (now - at < 60_000) n++;
    return n;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const cors = { "access-control-allow-origin": "*", "access-control-expose-headers": "Content-Length" };
    if (url.pathname === "/healthz") {
      const suspended = this.status === "suspended";
      return Response.json(
        {
          status: suspended ? "suspended" : this.registration ? "ok" : "starting",
          version: LIAR_VERSION,
          viewers: this.viewers(),
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (!url.pathname.startsWith("/hls/")) return new Response("not found\n", { status: 404 });
    if (req.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: { ...cors, "access-control-allow-methods": "GET, HEAD, OPTIONS" },
      });
    const path = url.pathname.slice("/hls/".length);
    const token = url.searchParams.get("t");
    const reg = this.registration;
    if (!reg || !this.originKey) return new Response("not registered\n", { status: 503, headers: cors });
    if (!validHlsPath(path)) return new Response("not found\n", { status: 404, headers: cors });
    if (!token) return new Response("missing token\n", { status: 401, headers: cors });
    const v = await verifyPlaybackToken(this.originKey, token);
    if (!v.ok) return new Response("invalid token\n", { status: 401, headers: cors });
    const c = v.value;
    if (c.src !== "relay" || c.rid !== this.relayId || !path.startsWith(`${c.path}/`))
      return new Response("token not valid for this relay or path\n", { status: 403, headers: cors });
    this.lastSeen.set(c.sid, Date.now());
    const upstream = new URL(`${reg.originUrl.replace(/\/+$/, "")}/relay-pull/${path}`);
    for (const [k, val] of url.searchParams) if (k !== "t") upstream.searchParams.set(k, val);
    let res: Response;
    try {
      res = await fetch(upstream, {
        headers: { authorization: `Bearer ${this.opts.token}`, "user-agent": `commonair-relay/${LIAR_VERSION}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return new Response("origin unreachable\n", { status: 502, headers: cors });
    }
    if (!res.ok) {
      await res.body?.cancel();
      return new Response(`origin HTTP ${res.status}\n`, { status: res.status === 404 ? 404 : 502, headers: cors });
    }
    if (path.endsWith(".m3u8")) {
      const body = tokenizePlaylist(await res.text(), token);
      return new Response(body, {
        headers: { ...cors, "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-cache" },
      });
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Media only, like the Go relay's receipts (and the origin's issuance).
    for (const map of [this.period, this.servedTotal]) {
      const t = map.get(c.sid) ?? { bytes: 0, segments: 0 };
      t.bytes += bytes.byteLength;
      t.segments += 1;
      map.set(c.sid, t);
    }
    this.egressBytes += bytes.byteLength;
    return new Response(bytes, {
      headers: { ...cors, "content-type": res.headers.get("content-type") ?? "application/octet-stream" },
    });
  }

  async stop(): Promise<void> {
    this.abort.abort(new Error("liar stopped"));
    await Promise.allSettled(this.loops);
    await this.server?.stop(true);
    this.server = null;
  }
}
