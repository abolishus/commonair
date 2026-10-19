// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, describe, expect, test } from "vite-plus/test";
import { Mailpit, mailpitEndpoint } from "../src/mailpit.ts";

const basic = (creds: string) => `Basic ${Buffer.from(creds).toString("base64")}`;

describe("mailpitEndpoint", () => {
  test("no credentials", () => {
    expect(mailpitEndpoint("http://localhost:8025/")).toEqual({ url: "http://localhost:8025", authorization: null });
  });
  test("explicit auth, split at the first colon", () => {
    expect(mailpitEndpoint("https://mail.example.test", "ops:pa:ss").authorization).toBe(basic("ops:pa:ss"));
  });
  test("URL userinfo becomes a header and leaves the URL", () => {
    const r = mailpitEndpoint("https://ops:p%40ss@mail.example.test/");
    expect(r).toEqual({ url: "https://mail.example.test", authorization: basic("ops:p@ss") });
  });
  test("explicit auth wins over userinfo", () => {
    expect(mailpitEndpoint("https://a:b@mail.example.test", "c:d").authorization).toBe(basic("c:d"));
  });
  test("auth without a colon is refused", () => {
    expect(() => mailpitEndpoint("http://localhost:8025", "nopassword")).toThrow(/user:password/);
  });
});

describe("Mailpit against a basic-auth server", () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.headers.get("authorization") !== basic("ops:secret")) return new Response("no", { status: 401 });
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/info") return Response.json({ Version: "test" });
      if (url.pathname === "/api/v1/search")
        return Response.json({
          messages: [
            { ID: "m1", Subject: "Verify", To: [{ Address: "a@harness.test" }], Created: "2026-10-18T00:00:00Z" },
          ],
        });
      return new Response("not found", { status: 404 });
    },
  });
  afterAll(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;

  test("without credentials the API is unreachable", async () => {
    expect(await new Mailpit(base).ping()).toBe(false);
    await expect(new Mailpit(base).search("to:x")).rejects.toThrow(/HTTP 401/);
  });
  test("with credentials it works", async () => {
    const m = new Mailpit(base, "ops:secret");
    expect(await m.ping()).toBe(true);
    expect((await m.search("to:x"))[0]?.id).toBe("m1");
  });
});
