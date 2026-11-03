// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { actorUrlRewrite } from "../../src/seed/platform/federation.ts";

const actor = "https://staging.example.org/ap/channels/c1";
const api = "http://api:3001";
const answer = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/activity+json" } });

describe("actorUrlRewrite", () => {
  test("served at the public origin (behind Caddy): URLs stay as published", async () => {
    const rewrite = await actorUrlRewrite(actor, api, answer(200, { id: actor }));
    expect(rewrite(`${actor}/inbox`)).toBe(`${actor}/inbox`);
  });

  test("not served there (the local web app): the instance's URLs go to the API port", async () => {
    for (const fetchFn of [
      answer(404, { error: "not found" }),
      answer(200, { id: "https://elsewhere.example/ap/x" }),
      answer(200, null),
      async () => new Response("<html>", { status: 200 }),
      async () => {
        throw new TypeError("connection refused");
      },
    ]) {
      const rewrite = await actorUrlRewrite(actor, api, fetchFn);
      expect(rewrite(`${actor}/inbox`)).toBe(`${api}/ap/channels/c1/inbox`);
      // Other hosts' URLs pass through.
      expect(rewrite("http://seed-harness:4000/actor")).toBe("http://seed-harness:4000/actor");
    }
  });

  test("the probe asks for the actor as ActivityPub JSON", async () => {
    const seen: { url: string; accept: string | null }[] = [];
    await actorUrlRewrite(actor, api, async (url, init) => {
      seen.push({ url, accept: new Headers(init.headers).get("accept") });
      return new Response("{}");
    });
    expect(seen).toEqual([{ url: actor, accept: "application/activity+json" }]);
  });
});
