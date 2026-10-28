// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** P1 harness pieces: the tracker proxy's token-to-address mapping, P2P params and record checks. */
import { describe, expect, test } from "vite-plus/test";
import { anyContains, loadCidrList, parseCidr, RESIDENTIAL_CIDRS_FILE } from "../src/cidrs.ts";
import { P2P_DIGEST_SERVED_QUERY, P2P_REJECTED_QUERY } from "../src/metrics.ts";
import {
  egressDropped,
  httpBytesPerSecond,
  P2P_VIEWERS_DEFAULT,
  p2pViewerParams,
  type SessionStats,
  unverified,
} from "../src/p2p.ts";
import { sessionAddress, sessionIdFromToken, startTrackerProxy } from "../src/proxy.ts";

const token = (claims: Record<string, unknown>) =>
  `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2lnbmF0dXJl`;
const SID = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";

describe("sessionIdFromToken", () => {
  test("reads the sid claim", () => {
    expect(sessionIdFromToken(token({ v: 1, sid: SID, cid: "c" }))).toBe(SID);
    expect(sessionIdFromToken(token({ sid: SID.toUpperCase() }))).toBe(SID);
  });

  test("null for anything unreadable", () => {
    for (const t of [null, undefined, "", ".", "!!!.sig", token({}), token({ sid: 5 }), token({ sid: "../x" })])
      expect(sessionIdFromToken(t)).toBeNull();
  });
});

describe("sessionAddress", () => {
  const cidrs = loadCidrList(RESIDENTIAL_CIDRS_FILE);

  test("deterministic, residential, and one /24 per session", () => {
    const a = sessionAddress(SID, cidrs);
    expect(sessionAddress(SID, cidrs)).toBe(a);
    expect(anyContains(cidrs, a)).toBe(true);
    const nets = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const ip = sessionAddress(crypto.randomUUID(), cidrs);
      expect(anyContains(cidrs, ip)).toBe(true);
      const last = Number(ip.split(".")[3]);
      expect(last).toBeGreaterThanOrEqual(1);
      expect(last).toBeLessThanOrEqual(254);
      nets.add(ip.split(".").slice(0, 3).join("."));
    }
    expect(nets.size).toBe(50);
  });

  test("ranges narrower than a /24 are never used", () => {
    expect(() => sessionAddress(SID, [parseCidr("192.0.2.0/25")])).toThrow(/24/);
    const ip = sessionAddress(SID, [parseCidr("192.0.2.0/25"), parseCidr("198.51.100.0/24")]);
    expect(ip.startsWith("198.51.100.")).toBe(true);
  });
});

describe("p2pViewerParams", () => {
  const params = (set: Record<string, number>) => (name: string, fallback: number) => set[name] ?? fallback;

  test("P1 is merged: ten opted-in viewers and one default viewer unless set", () => {
    expect(P2P_VIEWERS_DEFAULT).toBe(10);
    expect(p2pViewerParams(params({}))).toEqual({ optedIn: 10, atDefault: 1 });
    expect(p2pViewerParams(params({ p2p: 0 }))).toEqual({ optedIn: 0, atDefault: 0 });
  });

  test("one default viewer alongside opted-in ones, unless set", () => {
    expect(p2pViewerParams(params({ p2p: 10 }))).toEqual({ optedIn: 10, atDefault: 1 });
    expect(p2pViewerParams(params({ p2p: 10, p2pDefault: 3 }))).toEqual({ optedIn: 10, atDefault: 3 });
    expect(p2pViewerParams(params({ p2p: -2, p2pDefault: -1 }))).toEqual({ optedIn: 0, atDefault: 0 });
  });
});

describe("record checks", () => {
  const row = (o: Partial<SessionStats>): SessionStats => ({
    id: "s",
    bytes_http: 0,
    bytes_p2p: 0,
    watch_seconds: 0,
    verdict: "verified",
    verdict_reasons: null,
    ...o,
  });

  test("HTTP bytes per watched second", () => {
    expect(httpBytesPerSecond([])).toBeNull();
    expect(httpBytesPerSecond([row({ bytes_http: 100, watch_seconds: 0 })])).toBeNull();
    expect(
      httpBytesPerSecond([row({ bytes_http: 100, watch_seconds: 10 }), row({ bytes_http: 300, watch_seconds: 30 })]),
    ).toBe(10);
  });

  test("egress drop needs the margin and a baseline", () => {
    expect(egressDropped(80, 100)).toBe(true);
    expect(egressDropped(81, 100)).toBe(false);
    expect(egressDropped(50, null)).toBe(false);
    expect(egressDropped(null, 100)).toBe(false);
    expect(egressDropped(0, 0)).toBe(false);
  });

  test("unverified: any other verdict or a fetch reason", () => {
    expect(unverified([row({})])).toEqual([]);
    expect(unverified([row({ verdict: "pending" })])).toHaveLength(1);
    expect(unverified([row({ verdict_reasons: ["too_few_segments"] })])).toHaveLength(1);
    expect(unverified([row({ verdict_reasons: ["some_other_reason"] })])).toEqual([]);
  });

  test("PromQL", () => {
    expect(P2P_DIGEST_SERVED_QUERY(90)).toBe(
      'sum(increase(origin_requests_total{route="p2p_digest",status="200"}[90s]))',
    );
    expect(P2P_REJECTED_QUERY(0.2)).toBe("sum(increase(playback_p2p_rejected_total[1s]))");
  });
});

describe("tracker proxy", () => {
  test("forwards a session's socket with its address and relays both ways", async () => {
    const seen: { forwardedFor: string | null; query: string }[] = [];
    const tracker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        seen.push({ forwardedFor: req.headers.get("x-forwarded-for"), query: new URL(req.url).search });
        return srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, m) {
          ws.send(`echo:${String(m)}`);
        },
      },
    });
    const cidrs = [parseCidr("198.51.100.0/24")];
    const proxy = startTrackerProxy({ target: `ws://127.0.0.1:${tracker.port}`, port: 0, cidrs });
    try {
      const t = token({ sid: SID });
      const ws = new WebSocket(`${proxy.url}/?t=${t}`);
      const reply = await new Promise<string>((resolve, reject) => {
        ws.addEventListener("open", () => ws.send("announce"));
        ws.addEventListener("message", (e) => resolve(String(e.data)));
        ws.addEventListener("error", () => reject(new Error("socket error")));
        setTimeout(() => reject(new Error("timeout")), 5_000);
      });
      ws.close();
      expect(reply).toBe("echo:announce");
      expect(seen).toEqual([{ forwardedFor: sessionAddress(SID, cidrs), query: `?t=${t}` }]);

      const refused = await fetch(`${proxy.url.replace("ws:", "http:")}/?t=nope`);
      expect(refused.status).toBe(401);
    } finally {
      await proxy.stop();
      await tracker.stop(true);
    }
  });
});
