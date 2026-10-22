// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The overlay stream client: SSE parsing and the waiters, against a fake overlay endpoint. */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { SseParser, SseStream, overlayEventsUrl, refusedStream } from "../../src/e6/sse.ts";

describe("SseParser", () => {
  test("events split across arbitrary chunks", () => {
    const p = new SseParser();
    const text = 'event: alert\ndata: {"id":"a","text":"hi"}\n\nevent: ping\ndata: {}\n\n';
    const out = [];
    for (const ch of text) out.push(...p.push(ch));
    expect(out).toEqual([
      { event: "alert", data: '{"id":"a","text":"hi"}' },
      { event: "ping", data: "{}" },
    ]);
  });

  test("CRLF and lone CR line endings, a CR split from its LF", () => {
    const p = new SseParser();
    expect(p.push("event: a\r")).toEqual([]);
    expect(p.push("\ndata: 1\r\n\r\n")).toEqual([{ event: "a", data: "1" }]);
    // The trailing CR might be half of a CRLF: the event dispatches once the next chunk arrives.
    expect(p.push("data: 2\r\r")).toEqual([]);
    expect(p.push("data: 3\n\n")).toEqual([
      { event: "message", data: "2" },
      { event: "message", data: "3" },
    ]);
  });

  test("comments, multi-line data, ids and fields without a value", () => {
    const p = new SseParser();
    const out = p.push(": keepalive\nid: 7\ndata: one\ndata:two\ndata\n\n");
    expect(out).toEqual([{ event: "message", data: "one\ntwo\n", id: "7" }]);
  });

  test("an event with no data is dropped and its type reset", () => {
    const p = new SseParser();
    expect(p.push("event: revoked\n\n")).toEqual([]);
    expect(p.push("data: x\n\n")).toEqual([{ event: "message", data: "x" }]);
  });
});

describe("SseStream", () => {
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const enc = new TextEncoder();
        // A broken route that accepts a revoked token but ends the stream at once, sending nothing.
        if (url.searchParams.get("token") === "empty")
          return new Response(new ReadableStream({ start: (c) => c.close() }), {
            headers: { "content-type": "text/event-stream" },
          });
        if (url.searchParams.get("token") !== "good") return new Response(null, { status: 401 });
        const close = url.searchParams.get("close") === "1";
        const body = new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(enc.encode('event: alert\ndata: {"id":"1","amountCents":250,"test":false}\n\n'));
            await Bun.sleep(30);
            c.enqueue(enc.encode('event: alert\ndata: {"id":"2","amountCents":null,"test":true}\n\n'));
            if (close) {
              await Bun.sleep(30);
              c.enqueue(enc.encode("event: revoked\ndata: {}\n\n"));
              c.close();
            }
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
  });
  afterAll(() => server.stop(true));

  const url = (q: string) => `http://localhost:${server.port}/overlay/events?${q}`;

  test("records alerts, waits for one, closes on revoked", async () => {
    const s = await SseStream.open("t", url("token=good&close=1"));
    expect(s.status).toBe(200);
    const test = await s.waitEvent<{ test: boolean }>("alert", (a) => a.test, 2_000);
    expect(test.data.test).toBe(true);
    const closedAt = await s.waitClosed(2_000);
    expect(closedAt).toBeGreaterThan(0);
    expect(s.open).toBe(false);
    expect(s.ofType("alert").map((a) => (a.data as { id: string }).id)).toEqual(["1", "2"]);
    expect(s.events.at(-1)?.event).toBe("revoked");
    await s.close();
  });

  test("close() ends an open stream", async () => {
    const s = await SseStream.open("t", url("token=good"));
    await s.waitEvent("alert", () => true, 2_000);
    expect(s.open).toBe(true);
    await s.close();
    expect(s.closedAt).not.toBeNull();
  });

  test("a refused token is a closed stream with its status", async () => {
    const s = await SseStream.open("t", url("token=bad"));
    expect(s.status).toBe(401);
    expect(s.open).toBe(false);
    expect(s.closedAt).not.toBeNull();
  });

  test("an unreachable server is a closed stream without status", async () => {
    const s = await SseStream.open("t", "http://localhost:1/overlay/events", 2_000);
    expect(s.status).toBeNull();
    expect(s.open).toBe(false);
  });

  test("refusedStream: 401, or an empty stream closed at once, is refused; a live one is not", async () => {
    const bad = await SseStream.open("t", url("token=bad"));
    expect(await refusedStream(bad, 200)).toBe(true);
    const empty = await SseStream.open("t", url("token=empty"));
    expect(await refusedStream(empty, 1_000)).toBe(true);
    const live = await SseStream.open("t", url("token=good"));
    expect(await refusedStream(live, 300)).toBe(false);
    await live.close();
    // Delivered alerts and then closed: the token was accepted.
    const delivered = await SseStream.open("t", url("token=good&close=1"));
    expect(await refusedStream(delivered, 1_000)).toBe(false);
  });

  test("waitEvent times out naming the stream, not the URL", async () => {
    const s = await SseStream.open("overlay stream x", url("token=good"));
    await expect(s.waitEvent("alert", () => false, 200)).rejects.toThrow(/overlay stream x/);
    await s.close();
  });
});

describe("overlayEventsUrl", () => {
  test("OVERLAY_EVENTS_PATH on the API origin with the token", () => {
    const u = new URL(overlayEventsUrl("http://localhost:4000/some/base/", "tok/en+1"));
    expect(u.origin).toBe("http://localhost:4000");
    expect(u.pathname).toBe("/overlay/events");
    expect(u.searchParams.get("token")).toBe("tok/en+1");
  });
});
