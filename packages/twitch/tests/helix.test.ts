// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The Helix parsers and client, and the OAuth calls: fixtures, malformed answers, pagination, rate limits, no redirects. */
import { describe, expect, test } from "vite-plus/test";
import {
  authorizeUrl,
  exchangeCode,
  fixedUrl,
  HelixChannelsResponse,
  HelixClient,
  HelixEmotesResponse,
  HelixError,
  HelixScheduleResponse,
  HelixUsersResponse,
  readRateLimit,
  revokeToken,
  validateToken,
} from "../src/index.ts";
import { CHANNEL, EMOTES, json, SCHEDULE_PAGE_1, SCHEDULE_PAGE_2, scriptedFetch, USER } from "./fixtures.ts";

const TOKEN = "tok_secret_1234567890";
const BASE = "https://api.example.test/helix";
const AUTH = "https://id.example.test/oauth2";

const client = (f: typeof fetch, extra: Partial<ConstructorParameters<typeof HelixClient>[0]> = {}) =>
  new HelixClient({ baseUrl: BASE, clientId: "cid", token: TOKEN, fetch: f, ...extra });

async function rejection(p: Promise<unknown>): Promise<HelixError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HelixError);
  expect((err as Error).message).not.toContain(TOKEN);
  return err as HelixError;
}

describe("parsers", () => {
  test("fixture answers parse to the fields decision 2 names", () => {
    const u = HelixUsersResponse.parse({ data: [USER] }).data[0];
    expect(u).toEqual({
      id: USER.id,
      login: USER.login,
      display_name: USER.display_name,
      description: USER.description,
    });
    const c = HelixChannelsResponse.parse({ data: [CHANNEL] }).data[0];
    expect(c?.game_name).toBe("Pixel Art Gardening");
    expect(c?.content_classification_labels).toEqual(["MatureGame"]);
    expect(Object.keys(c ?? {})).not.toContain("delay");
    const e = HelixEmotesResponse.parse(EMOTES);
    expect(e.data).toHaveLength(8);
    expect(e.data[0]?.tier).toBe("1000");
    expect(e.template).toContain("{{id}}");
    const s = HelixScheduleResponse.parse(SCHEDULE_PAGE_1);
    expect(s.data.segments?.[0]?.category?.name).toBe("Pixel Art Gardening");
    expect(s.pagination?.cursor).toBe("page2");
  });

  test("missing optional fields take their defaults", () => {
    const c = HelixChannelsResponse.parse({ data: [{ broadcaster_id: "1", broadcaster_login: "a" }] }).data[0];
    expect(c).toMatchObject({ title: "", game_name: "", broadcaster_language: "" });
    expect(HelixUsersResponse.parse({ data: [{ id: "1", login: "a", display_name: "A" }] }).data[0]?.description).toBe(
      "",
    );
    expect(HelixScheduleResponse.parse({ data: { segments: null } }).data.segments).toBeNull();
  });

  test("malformed answers are refused", () => {
    expect(HelixUsersResponse.safeParse({ data: [{ login: "a" }] }).success).toBe(false);
    expect(HelixUsersResponse.safeParse({}).success).toBe(false);
    expect(
      HelixEmotesResponse.safeParse({
        data: [{ id: "1", name: "x", images: { url_1x: "nope" }, emote_type: "follower" }],
      }).success,
    ).toBe(false);
    expect(HelixScheduleResponse.safeParse({ data: { segments: [{ start_time: "tomorrow" }] } }).success).toBe(false);
    expect(HelixChannelsResponse.safeParse({ data: [{ broadcaster_id: "", broadcaster_login: "a" }] }).success).toBe(
      false,
    );
  });
});

describe("HelixClient", () => {
  test("reads the user, channel and emotes with the client id and token", async () => {
    const s = scriptedFetch((url) => {
      if (url.pathname === "/helix/users") return json({ data: [USER] });
      if (url.pathname === "/helix/channels") return json({ data: [CHANNEL] });
      if (url.pathname === "/helix/chat/emotes") return json(EMOTES);
      return json({}, 404);
    });
    const c = client(s.fetch);
    expect((await c.me()).login).toBe("pixelgardener");
    expect((await c.channel("90000001")).title).toBe(CHANNEL.title);
    expect((await c.emotes("90000001")).data).toHaveLength(8);
    for (const call of s.calls) {
      const h = new Headers(call.init.headers);
      expect(h.get("client-id")).toBe("cid");
      expect(h.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(call.init.redirect).toBe("error");
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(call.url.origin).toBe("https://api.example.test");
    }
    expect(s.calls[1]?.url.searchParams.get("broadcaster_id")).toBe("90000001");
  });

  test("the schedule follows the cursor across pages and stops at the cap", async () => {
    const s = scriptedFetch((url) =>
      json(url.searchParams.get("after") === "page2" ? SCHEDULE_PAGE_2 : SCHEDULE_PAGE_1),
    );
    const all = await client(s.fetch).schedule("90000001", 200);
    expect(all.map((x) => x.title)).toEqual(["Seed swap Tuesday", "Harvest stream"]);
    expect(s.calls.map((c) => c.url.searchParams.get("after"))).toEqual([null, "page2"]);
    expect(s.calls[0]?.url.searchParams.get("first")).toBe("25");
    const capped = scriptedFetch(() => json(SCHEDULE_PAGE_1));
    expect(await client(capped.fetch).schedule("1", 1)).toHaveLength(1);
    expect(capped.calls).toHaveLength(1);
  });

  test("a repeated cursor ends the pagination instead of looping", async () => {
    const s = scriptedFetch(() => json({ ...SCHEDULE_PAGE_1, pagination: { cursor: "same" } }));
    const got = await client(s.fetch).schedule("1", 200);
    expect(s.calls.length).toBeLessThanOrEqual(2);
    expect(got.length).toBe(s.calls.length);
  });

  test("a channel with no schedule answers 404: empty", async () => {
    const s = scriptedFetch(() => json({ error: "Not Found" }, 404));
    expect(await client(s.fetch).schedule("1", 200)).toEqual([]);
  });

  test("malformed and failed answers throw without the token", async () => {
    const bad = scriptedFetch(() => json({ data: [{ nope: 1 }] }));
    expect((await rejection(client(bad.fetch).me())).kind).toBe("malformed");
    const two = scriptedFetch(() => json({ data: [USER, USER] }));
    expect((await rejection(client(two.fetch).me())).kind).toBe("malformed");
    const err = scriptedFetch(() => json({ message: TOKEN }, 500));
    const e = await rejection(client(err.fetch).channel("1"));
    expect([e.kind, e.status]).toEqual(["http", 500]);
    const net = scriptedFetch(() => {
      throw new TypeError(`connect failed ${TOKEN}`);
    });
    expect((await rejection(client(net.fetch).me())).kind).toBe("network");
    const empty = scriptedFetch(() => json({ data: [] }));
    expect((await rejection(client(empty.fetch).channel("1"))).kind).toBe("malformed");
  });

  test("a redirect is never followed", async () => {
    const s = scriptedFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.test/" } }));
    expect((await rejection(client(s.fetch).me())).kind).toBe("host");
    expect(s.calls).toHaveLength(1);
  });

  test("a 429 waits for the reset once, then succeeds", async () => {
    let now = 1_000_000;
    const slept: number[] = [];
    const s = scriptedFetch((_u, _i, n) =>
      n === 1
        ? json({}, 429, { "ratelimit-remaining": "0", "ratelimit-reset": String((now + 2_000) / 1000) })
        : json({ data: [USER] }, 200, {
            "ratelimit-limit": "800",
            "ratelimit-remaining": "799",
            "ratelimit-reset": "1",
          }),
    );
    const c = client(s.fetch, {
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    expect((await c.me()).id).toBe(USER.id);
    expect(slept).toEqual([2_000]);
    expect(c.rateLimit).toEqual({ limit: 800, remaining: 799, resetAt: 1000 });
  });

  test("a 429 whose reset is too far, or a second 429, gives up", async () => {
    const now = 1_000_000;
    const far = scriptedFetch(() => json({}, 429, { "ratelimit-reset": String((now + 60_000) / 1000) }));
    const e = await rejection(client(far.fetch, { now: () => now, sleep: async () => {} }).me());
    expect([e.kind, far.calls.length]).toEqual(["rate_limited", 1]);
    const twice = scriptedFetch(() => json({}, 429, { "ratelimit-reset": String(now / 1000) }));
    await rejection(client(twice.fetch, { now: () => now, sleep: async () => {} }).me());
    expect(twice.calls).toHaveLength(2);
  });

  test("an exhausted budget waits for the reset before the next call", async () => {
    let now = 5_000_000;
    const slept: number[] = [];
    const s = scriptedFetch(() =>
      json({ data: [USER] }, 200, { "ratelimit-remaining": "0", "ratelimit-reset": String((now + 1_500) / 1000) }),
    );
    const c = client(s.fetch, {
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    await c.me();
    await c.me();
    expect(slept).toEqual([1_500]);
  });

  test("readRateLimit and fixedUrl", () => {
    expect(readRateLimit(new Headers())).toEqual({ limit: null, remaining: null, resetAt: null });
    expect(readRateLimit(new Headers({ "ratelimit-remaining": "x" })).remaining).toBeNull();
    expect(fixedUrl(BASE, "chat/emotes", { broadcaster_id: "1" }).toString()).toBe(
      "https://api.example.test/helix/chat/emotes?broadcaster_id=1",
    );
    expect(fixedUrl("http://host:4791/helix/", "/users").toString()).toBe("http://host:4791/helix/users");
    expect(fixedUrl(BASE, "//evil.test/x").origin).toBe("https://api.example.test");
  });
});

describe("oauth", () => {
  test("the authorize URL requests no scopes", () => {
    const u = new URL(
      authorizeUrl({ authBaseUrl: AUTH, clientId: "cid", redirectUri: "https://ca.test/cb", state: "s.t" }),
    );
    expect(u.origin + u.pathname).toBe("https://id.example.test/oauth2/authorize");
    expect(u.searchParams.get("scope")).toBe("");
    expect(u.searchParams.getAll("scope")).toEqual([""]);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "cid",
      redirect_uri: "https://ca.test/cb",
      response_type: "code",
      scope: "",
      state: "s.t",
      force_verify: "true",
    });
  });

  test("exchange, validate and revoke", async () => {
    const s = scriptedFetch(async (url) => {
      if (url.pathname === "/oauth2/token") return json({ access_token: TOKEN, token_type: "bearer", scope: [] });
      if (url.pathname === "/oauth2/validate")
        return json({ client_id: "cid", login: "pixelgardener", user_id: "90000001", scopes: [], expires_in: 100 });
      if (url.pathname === "/oauth2/revoke") return new Response(null, { status: 200 });
      return json({}, 404);
    });
    const form = (i: number) => Object.fromEntries(new URLSearchParams(s.calls[i]?.init.body as URLSearchParams));
    const opts = { authBaseUrl: AUTH, fetch: s.fetch };
    const t = await exchangeCode({
      ...opts,
      clientId: "cid",
      clientSecret: "sec",
      code: "abc",
      redirectUri: "https://ca.test/cb",
    });
    expect(t).toEqual({ accessToken: TOKEN, scopes: [] });
    expect(await validateToken({ ...opts, token: TOKEN })).toEqual({
      clientId: "cid",
      login: "pixelgardener",
      userId: "90000001",
      scopes: [],
    });
    expect(await revokeToken({ ...opts, clientId: "cid", token: TOKEN })).toBe(true);
    expect(s.calls.map((c) => [c.init.method, c.url.pathname])).toEqual([
      ["POST", "/oauth2/token"],
      ["GET", "/oauth2/validate"],
      ["POST", "/oauth2/revoke"],
    ]);
    expect(form(0)).toEqual({
      client_id: "cid",
      client_secret: "sec",
      code: "abc",
      grant_type: "authorization_code",
      redirect_uri: "https://ca.test/cb",
    });
    expect(new Headers(s.calls[1]?.init.headers).get("authorization")).toBe(`OAuth ${TOKEN}`);
    expect(form(2)).toEqual({ client_id: "cid", token: TOKEN });
    for (const c of s.calls) expect(c.init.redirect).toBe("error");
  });

  test("failures throw without the token; a refused revoke answers false", async () => {
    const s = scriptedFetch(() => json({ message: "invalid" }, 400));
    const opts = { authBaseUrl: AUTH, fetch: s.fetch };
    expect(
      (await rejection(exchangeCode({ ...opts, clientId: "c", clientSecret: "s", code: "x", redirectUri: "r" })))
        .status,
    ).toBe(400);
    expect((await rejection(validateToken({ ...opts, token: TOKEN }))).kind).toBe("http");
    expect(await revokeToken({ ...opts, clientId: "c", token: TOKEN })).toBe(false);
    const junk = scriptedFetch(() => json({ token: TOKEN }));
    expect(
      (
        await rejection(
          exchangeCode({
            authBaseUrl: AUTH,
            fetch: junk.fetch,
            clientId: "c",
            clientSecret: "s",
            code: "x",
            redirectUri: "r",
          }),
        )
      ).kind,
    ).toBe("malformed");
  });
});
