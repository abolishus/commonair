// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The rehearsal driver's wiring: the chat dry-run client, the MediaMTX kick and the config. */
import { describe, expect, test } from "vite-plus/test";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER } from "@commonair/contracts/internal";
import { chatHttpBase, httpChatProbe, mediamtxKick, rehearsalConfig } from "../src/jobs/rehearsal-driver.ts";

type Call = { url: string; init: RequestInit | undefined };
const fakeFetch = (respond: (url: string, init?: RequestInit) => Response) => {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return { f, calls };
};

describe("chatHttpBase", () => {
  test("the chat service's HTTP origin from its WebSocket URL", () => {
    expect(chatHttpBase("ws://chat:3002/ws")).toBe("http://chat:3002");
    expect(chatHttpBase("wss://chat.internal/ws")).toBe("https://chat.internal");
    expect(chatHttpBase("ws://localhost:3002/ws")).toBe("http://localhost:3002");
  });
});

describe("httpChatProbe", () => {
  test("posts the synthetic message with the internal secret and parses the outcome", async () => {
    const { f, calls } = fakeFetch(() => Response.json({ outcome: "rejected", code: "msg_duplicate" }));
    const probe = httpChatProbe({ baseUrl: "http://chat:3002", secret: "s3cret", fetch: f });
    const r = await probe.send("0197f0aa-0000-7000-8000-000000000001", "v001", "hello");
    expect(r).toEqual({ outcome: "rejected", code: "msg_duplicate" });
    expect(calls[0]?.url).toBe(`http://chat:3002${INTERNAL_ROUTES.chatDryRun}`);
    expect(calls[0]?.init?.method).toBe("POST");
    const init = calls[0]?.init ?? {};
    expect((init.headers as Record<string, string>)[INTERNAL_SECRET_HEADER]).toBe("s3cret");
    expect(JSON.parse(init.body as string)).toEqual({
      channelId: "0197f0aa-0000-7000-8000-000000000001",
      senderKey: "v001",
      body: "hello",
    });
  });

  test("a failed or malformed answer throws (the driver retries next tick)", async () => {
    const down = httpChatProbe({
      baseUrl: "http://c",
      secret: "s",
      fetch: fakeFetch(() => new Response("", { status: 503 })).f,
    });
    await expect(down.send("c", "v", "b")).rejects.toThrow("503");
    const odd = httpChatProbe({
      baseUrl: "http://c",
      secret: "s",
      fetch: fakeFetch(() => Response.json({ outcome: "?" })).f,
    });
    await expect(odd.send("c", "v", "b")).rejects.toThrow(/outcome/);
  });
});

describe("mediamtxKick", () => {
  test("looks up the path's source and kicks it with the internal user", async () => {
    const { f, calls } = fakeFetch((url) =>
      url.includes("/v3/paths/get/") ? Response.json({ source: { type: "rtmpConn", id: "abc" } }) : new Response(""),
    );
    expect(await mediamtxKick({ apiUrl: "http://mediamtx:9997/", password: "pw", fetch: f })("live/slug")).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "http://mediamtx:9997/v3/paths/get/live/slug",
      "http://mediamtx:9997/v3/rtmpconns/kick/abc",
    ]);
    expect(((calls[0]?.init ?? {}).headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("internal:pw").toString("base64")}`,
    );
  });

  test("nothing to kick: no path, no source, an unknown source type", async () => {
    const kickWith = (r: Response) => mediamtxKick({ apiUrl: "http://m", password: "p", fetch: fakeFetch(() => r).f });
    expect(await kickWith(new Response("", { status: 404 }))("live/x")).toBe(false);
    expect(await kickWith(Response.json({ source: null }))("live/x")).toBe(false);
    expect(await kickWith(Response.json({ source: { type: "hlsSource", id: "1" } }))("live/x")).toBe(false);
  });
});

describe("rehearsalConfig", () => {
  test("chat needs the internal secret, the kick the media password", () => {
    expect(rehearsalConfig({})).toEqual({ chat: null, kick: null });
    expect(
      rehearsalConfig({
        INTERNAL_API_SECRET: "s",
        CHAT_INTERNAL_URL: "ws://chat:3002/ws",
        MEDIA_INTERNAL_PASSWORD: "p",
        MEDIAMTX_API_URL: "http://mediamtx:9997",
      }),
    ).toEqual({
      chat: { baseUrl: "http://chat:3002", secret: "s" },
      kick: { apiUrl: "http://mediamtx:9997", password: "p" },
    });
    expect(rehearsalConfig({ INTERNAL_API_SECRET: "s" }).chat?.baseUrl).toBe("http://localhost:3002");
  });
});
