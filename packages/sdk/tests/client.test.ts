// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vite-plus/test";
import { createClient, errorCode, retryAfterSeconds } from "../src/index.ts";

/** An oRPC RPC-protocol answer: `{ json, meta }` for success, an error envelope with `defined: true` for errors. */
const rpcOk = (json: unknown) => Response.json({ json, meta: [] });
const rpcError = (status: number, code: string, data?: unknown) =>
  Response.json({ json: { defined: true, code, status, message: code, data }, meta: [] }, { status });

describe("createClient", () => {
  test("calls ${baseUrl}/rpc/<path> with the bearer token and extra headers", async () => {
    const seen: Request[] = [];
    const client = createClient({
      baseUrl: "https://api.example.test/",
      token: "tok_1",
      headers: { "user-agent": "my-bot/1.0" },
      fetch: async (r) => {
        seen.push(r);
        return rpcOk({ token: "chat", url: "wss://chat.example.test/ws", expiresAt: "2026-10-29T12:00:00.000Z" });
      },
    });
    const out = await client.chat.connectToken();
    expect(out.url).toBe("wss://chat.example.test/ws");
    expect(seen[0]?.url).toBe("https://api.example.test/rpc/chat/connectToken");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer tok_1");
    expect(seen[0]?.headers.get("user-agent")).toBe("my-bot/1.0");
  });

  test("getToken is awaited on every call and wins over token", async () => {
    let n = 0;
    const auth: (string | null)[] = [];
    const client = createClient({
      baseUrl: "https://api.example.test",
      token: "static",
      getToken: async () => `fresh_${++n}`,
      fetch: async (r) => {
        auth.push(r.headers.get("authorization"));
        return rpcOk({ token: "t", url: "wss://x.test", expiresAt: "2026-10-29T12:00:00.000Z" });
      },
    });
    await client.chat.connectToken();
    await client.chat.connectToken();
    expect(auth).toEqual(["Bearer fresh_1", "Bearer fresh_2"]);
  });

  test("no token, no authorization header", async () => {
    let header: string | null = "unset";
    const client = createClient({
      baseUrl: "https://api.example.test",
      fetch: async (r) => {
        header = r.headers.get("authorization");
        return rpcOk({ token: "t", url: "wss://x.test", expiresAt: "2026-10-29T12:00:00.000Z" });
      },
    });
    await client.chat.connectToken();
    expect(header).toBeNull();
  });

  test("RATE_LIMITED surfaces as a typed oRPC error with retryAfterSeconds", async () => {
    const client = createClient({
      baseUrl: "https://api.example.test",
      token: "t",
      fetch: async () => rpcError(429, "RATE_LIMITED", { retryAfterSeconds: 7 }),
    });
    const err = await client.chat.connectToken().catch((e: unknown) => e);
    expect(errorCode(err)).toBe("RATE_LIMITED");
    expect(retryAfterSeconds(err)).toBe(7);
    expect(retryAfterSeconds(new Error("x"))).toBeNull();
    expect(errorCode("nope")).toBeNull();
  });

  test("FORBIDDEN keeps its code; the timeout aborts a hung request", async () => {
    const forbidden = createClient({ baseUrl: "https://x.test", fetch: async () => rpcError(403, "FORBIDDEN") });
    expect(errorCode(await forbidden.chat.connectToken().catch((e: unknown) => e))).toBe("FORBIDDEN");
    const hung = createClient({
      baseUrl: "https://x.test",
      timeoutMs: 50,
      fetch: (r) =>
        new Promise((_resolve, reject) => r.signal.addEventListener("abort", () => reject(r.signal.reason as Error))),
    });
    const started = Date.now();
    await expect(hung.chat.connectToken()).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
