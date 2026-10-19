// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The over-reporting TypeScript relay: receipt construction and the relay protocol against fakes. */
import { ReceiptPayload } from "@commonair/contracts";
import { generateSigningKey, signPlaybackToken, verifyReceipt } from "@commonair/tokens";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  LIAR_FACTOR,
  LiarRelay,
  buildLiarReceipt,
  inflatedEntries,
  minuteFloor,
  tokenizePlaylist,
  validHlsPath,
} from "../src/liar-relay.ts";
import { freePort } from "../src/relay.ts";

const RELAY_ID = "0192f0c4-0000-7000-8000-000000000001";
const SID_A = "0192f0c4-0000-7000-8000-00000000000a";
const SID_B = "0192f0c4-0000-7000-8000-00000000000b";
const CHANNEL_ID = "0192f0c4-0000-7000-8000-0000000000cc";

describe("liar receipts", () => {
  test("correctly signed, claiming 5× the served bytes", async () => {
    const { key } = await generateSigningKey();
    const served = new Map([
      [SID_A, { bytes: 1_000, segments: 2 }],
      [SID_B, { bytes: 333, segments: 1 }],
    ]);
    const period = { start: new Date("2026-10-18T12:00:00.000Z"), end: new Date("2026-10-18T12:01:00.000Z") };
    const { payload, receipt } = await buildLiarReceipt(key, RELAY_ID, period, served);
    expect(LIAR_FACTOR).toBe(5);
    expect(payload.entries).toEqual([
      { sessionId: SID_A, segments: 2, bytes: 5_000 },
      { sessionId: SID_B, segments: 1, bytes: 1_665 },
    ]);
    expect(payload).toMatchObject({ v: 1, relayId: RELAY_ID, periodStart: "2026-10-18T12:00:00.000Z" });
    expect(ReceiptPayload.safeParse(payload).success).toBe(true);
    const v = await verifyReceipt(key.publicKeyB64, receipt);
    expect(v).toEqual({ ok: true, value: payload });
    // Another key does not verify it: the signature is the liar's own.
    const other = (await generateSigningKey()).key;
    expect((await verifyReceipt(other.publicKeyB64, receipt)).ok).toBe(false);
  });

  test("fresh nonce per receipt; assigned sessions without bytes are listed at 0", async () => {
    const { key } = await generateSigningKey();
    const period = { start: new Date(0), end: new Date(60_000) };
    const served = new Map([[SID_A, { bytes: 10, segments: 1 }]]);
    const a = await buildLiarReceipt(key, RELAY_ID, period, served, [SID_B]);
    const b = await buildLiarReceipt(key, RELAY_ID, period, served, [SID_B]);
    expect(a.payload.nonce).not.toBe(b.payload.nonce);
    expect(a.payload.nonce.length).toBeGreaterThanOrEqual(16);
    expect(a.payload.entries).toContainEqual({ sessionId: SID_B, segments: 0, bytes: 0 });
  });

  test("inflatedEntries rounds and dedupes", () => {
    const served = new Map([[SID_A, { bytes: 3, segments: 1 }]]);
    expect(inflatedEntries(served, [SID_A], 2.5)).toEqual([{ sessionId: SID_A, segments: 1, bytes: 8 }]);
    expect(inflatedEntries(new Map(), [], 5)).toEqual([]);
  });

  test("minuteFloor", () => {
    expect(minuteFloor(Date.parse("2026-10-18T12:00:59.999Z"))).toBe(Date.parse("2026-10-18T12:00:00.000Z"));
    expect(minuteFloor(Date.parse("2026-10-18T12:01:00.000Z"))).toBe(Date.parse("2026-10-18T12:01:00.000Z"));
  });
});

describe("liar pass-through helpers", () => {
  test("tokenizePlaylist adds t to URI lines and URI attributes once", () => {
    const body = [
      "#EXTM3U",
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/index.m3u8?x=1"',
      "#EXTINF:1.0,",
      "seg1.mp4",
      "seg2.mp4?t=already",
      "",
    ].join("\r\n");
    expect(tokenizePlaylist(body, "a b").split("\n")).toEqual([
      "#EXTM3U",
      '#EXT-X-MAP:URI="init.mp4?t=a%20b"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/index.m3u8?x=1&t=a%20b"',
      "#EXTINF:1.0,",
      "seg1.mp4?t=a%20b",
      "seg2.mp4?t=already",
      "",
    ]);
  });

  test("validHlsPath mirrors the Go relay's path rules", () => {
    expect(validHlsPath("live/alice/index.m3u8")).toBe(true);
    expect(validHlsPath("live/alice/720p/seg_1.mp4")).toBe(true);
    expect(validHlsPath("live/../etc/passwd")).toBe(false);
    expect(validHlsPath("live//a")).toBe(false);
    expect(validHlsPath(".hidden/x")).toBe(false);
    expect(validHlsPath("a/b/c/d/e/f/g/h/i")).toBe(false);
  });
});

describe("liar relay against a fake API and origin", () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  let liar: LiarRelay | null = null;
  afterEach(async () => {
    await liar?.stop();
    liar = null;
    for (const s of servers.splice(0)) await s.stop(true);
  });

  test("registers, serves assigned viewers from /relay-pull/, submits an inflated signed receipt", async () => {
    const origin = await generateSigningKey();
    const calls: { path: string; auth: string | null; body: unknown }[] = [];
    const pulls: string[] = [];
    const originSrv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (req.headers.get("authorization") !== "Bearer relay_tok") return new Response("no", { status: 401 });
        pulls.push(url.pathname + url.search);
        if (url.pathname === "/relay-pull/live/al/index.m3u8")
          return new Response('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nseg1.mp4\n');
        if (url.pathname === "/relay-pull/live/al/seg1.mp4") return new Response(new Uint8Array(4_000));
        return new Response("missing", { status: 404 });
      },
    });
    servers.push(originSrv);
    const api = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        const body: unknown = await req.json();
        calls.push({ path: url.pathname, auth: req.headers.get("authorization"), body });
        if (url.pathname === "/api/relay/register") {
          // The API health-checks the relay while registering.
          const health = await fetch(`${(body as { publicUrl: string }).publicUrl}/healthz`);
          if (!health.ok) return new Response("unhealthy", { status: 400 });
          return Response.json({
            relayId: RELAY_ID,
            originUrl: `http://127.0.0.1:${originSrv.port}`,
            originPublicKey: origin.key.publicKeyB64,
            receiptIntervalSeconds: 60,
            heartbeatIntervalSeconds: 15,
            status: "active",
          });
        }
        if (url.pathname === "/api/relay/receipts")
          return Response.json({ receiptId: "0192f0c4-0000-7000-8000-0000000000ee", status: "pending" });
        return Response.json({ status: "active", originPublicKey: origin.key.publicKeyB64 });
      },
    });
    servers.push(api);
    const port = await freePort();
    liar = new LiarRelay({ apiUrl: `http://127.0.0.1:${api.port}/`, token: "relay_tok", host: "127.0.0.1", port });
    const reg = await liar.start();
    expect(reg.relayId).toBe(RELAY_ID);
    expect(liar.status).toBe("active");
    const register = calls.find((c) => c.path === "/api/relay/register");
    expect(register?.auth).toBe("Bearer relay_tok");
    const relayPublicKey = (register?.body as { publicKey?: string } | undefined)?.publicKey ?? "";
    expect(relayPublicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const now = Math.floor(Date.now() / 1000);
    const claims = { v: 1 as const, sid: SID_A, cid: CHANNEL_ID, path: "live/al", iat: now, exp: now + 120 };
    const tok = await signPlaybackToken(origin.key, { ...claims, src: "relay", rid: RELAY_ID });
    const base = `http://127.0.0.1:${port}/hls/live/al`;
    const playlist = await fetch(`${base}/index.m3u8?t=${encodeURIComponent(tok)}`);
    expect(playlist.status).toBe(200);
    const text = await playlist.text();
    expect(text).toContain(`seg1.mp4?t=${encodeURIComponent(tok)}`);
    expect(text).toContain(`URI="init.mp4?t=${encodeURIComponent(tok)}"`);
    const seg = await fetch(`${base}/seg1.mp4?t=${encodeURIComponent(tok)}`);
    expect((await seg.arrayBuffer()).byteLength).toBe(4_000);
    // The viewer token never reaches the origin; the relay token does.
    expect(pulls.every((p) => !p.includes("t="))).toBe(true);

    // Tokens for the origin, another relay, or another path are refused.
    const originTok = await signPlaybackToken(origin.key, { ...claims, src: "origin" });
    expect((await fetch(`${base}/seg1.mp4?t=${encodeURIComponent(originTok)}`)).status).toBe(403);
    const otherRelay = await signPlaybackToken(origin.key, { ...claims, src: "relay", rid: SID_B });
    expect((await fetch(`${base}/seg1.mp4?t=${encodeURIComponent(otherRelay)}`)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}/hls/live/bob/seg1.mp4?t=${encodeURIComponent(tok)}`)).status).toBe(
      403,
    );
    expect((await fetch(`${base}/seg1.mp4`)).status).toBe(401);
    expect((await fetch(`${base}/seg1.mp4?t=garbage`)).status).toBe(401);

    const health = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as {
      status: string;
      viewers: number;
    };
    expect(health).toMatchObject({ status: "ok", viewers: 1 });

    liar.assign([SID_B]);
    const record = await liar.submitPeriod();
    expect(record).toMatchObject({ bytesServed: 4_000, bytesClaimed: 20_000, sessions: 2, status: "pending" });
    const submitted = calls.find((c) => c.path === "/api/relay/receipts")?.body as {
      payload: string;
      signature: string;
    };
    const v = await verifyReceipt(relayPublicKey, submitted);
    expect(v.ok).toBe(true);
    const verified = v.ok ? v.value : null;
    expect(verified?.relayId).toBe(RELAY_ID);
    expect(verified?.entries.find((e) => e.sessionId === SID_A)?.bytes).toBe(20_000);
    // The next period starts empty: nothing served, nothing submitted.
    expect(await liar.submitPeriod()).toBeNull();
    expect(liar.servedTotal.get(SID_A)).toEqual({ bytes: 4_000, segments: 1 });
  });

  test("a refused registration explains the private-network setting", async () => {
    const api = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ code: "BAD_REQUEST", message: "publicUrl: must be https" }, { status: 400 }),
    });
    servers.push(api);
    liar = new LiarRelay({
      apiUrl: `http://127.0.0.1:${api.port}`,
      token: "relay_tok",
      host: "127.0.0.1",
      port: await freePort(),
    });
    await expect(liar.start()).rejects.toThrow(/OUTBOUND_ALLOW_PRIVATE_NETWORKS=true/);
  });
});
