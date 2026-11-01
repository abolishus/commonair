// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The in-harness Twitch mock (N3-import) on its own: OAuth (authorize with a one-time code, token,
 * validate, revoke recorded), Helix behind a live token with rate-limit headers and a paginated
 * schedule, and the CDN (generated PNGs, the T0 fixture for `pgBad`). Plus the scenario's own
 * constants: every step has a runner, and step 7's expected panels are what `panelPaste` makes of
 * the paste.
 */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { panelPaste } from "../../../packages/twitch/src/panels.ts";
import { startTwitchMock, TWITCH_FIXTURE, type TwitchMock } from "../../src/mocks/twitch/server.ts";
import { PANEL_EXPECTED, PANEL_PASTE, TWITCH_IMPORT_STEP_RUNNERS, TWITCH_MOCK_PORT } from "../../src/n3/index.ts";
import { TWITCH_IMPORT_STEP_NUMBERS } from "../../src/w3/steps.ts";

const T0 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
let mock: TwitchMock;

beforeAll(async () => {
  mock = await startTwitchMock({ hostname: "127.0.0.1", publicHost: "127.0.0.1", t0Image: T0, maxPage: 2 });
});
afterAll(async () => {
  await mock?.close();
});

const REDIRECT = "http://localhost:3000/api/twitch-import/callback";

async function authorize(state = "st"): Promise<URL> {
  const u = new URL(`${mock.authBase}/authorize`);
  for (const [k, v] of Object.entries({
    client_id: mock.clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "",
    state,
  }))
    u.searchParams.set(k, v);
  const res = await fetch(u, { redirect: "manual" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "");
}

async function token(code: string, over: Record<string, string> = {}): Promise<Response> {
  return fetch(`${mock.authBase}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: mock.clientId,
      client_secret: mock.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
      ...over,
    }),
  });
}

async function issue(): Promise<string> {
  const cb = await authorize();
  const res = await token(cb.searchParams.get("code") ?? "");
  return ((await res.json()) as { access_token: string }).access_token;
}

const helix = (path: string, tok: string, clientId = mock.clientId) =>
  fetch(`${mock.apiBase}/${path}`, { headers: { "client-id": clientId, authorization: `Bearer ${tok}` } });

describe("OAuth", () => {
  test("authorize redirects back with the state and a one-time code", async () => {
    const cb = await authorize("abc");
    expect(cb.origin + cb.pathname).toBe(REDIRECT);
    expect(cb.searchParams.get("state")).toBe("abc");
    expect(cb.searchParams.get("scope")).toBe("");
    const code = cb.searchParams.get("code") ?? "";
    expect((await token(code)).status).toBe(200);
    expect((await token(code)).status).toBe(400);
    expect(mock.authorizations.at(-1)?.scope).toBe("");
  });

  test("the token needs the right secret and redirect URI", async () => {
    const a = await authorize();
    expect((await token(a.searchParams.get("code") ?? "", { client_secret: "wrong" })).status).toBe(400);
    const b = await authorize();
    expect((await token(b.searchParams.get("code") ?? "", { redirect_uri: "http://evil.test/cb" })).status).toBe(400);
  });

  test("deny redirects with access_denied and no code", async () => {
    mock.deny = true;
    try {
      const cb = await authorize();
      expect(cb.searchParams.get("error")).toBe("access_denied");
      expect(cb.searchParams.has("code")).toBe(false);
    } finally {
      mock.deny = false;
    }
  });

  test("validate names the user; revoke is recorded and ends the token", async () => {
    const tok = await issue();
    const v = await fetch(`${mock.authBase}/validate`, { headers: { authorization: `OAuth ${tok}` } });
    expect(await v.json()).toMatchObject({
      client_id: mock.clientId,
      login: TWITCH_FIXTURE.login,
      user_id: TWITCH_FIXTURE.userId,
      scopes: [],
    });
    const r = await fetch(`${mock.authBase}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: mock.clientId, token: tok }),
    });
    expect(r.status).toBe(200);
    expect(mock.revocations).toContain(tok);
    expect((await helix("users", tok)).status).toBe(401);
  });

  test("authorizeAs picks the account the code proves", async () => {
    mock.authorizeAs = TWITCH_FIXTURE.otherLogin;
    try {
      const tok = await issue();
      const u = (await (await helix("users", tok)).json()) as { data: { login: string }[] };
      expect(u.data[0]?.login).toBe(TWITCH_FIXTURE.otherLogin);
    } finally {
      mock.authorizeAs = TWITCH_FIXTURE.login;
    }
  });
});

describe("Helix", () => {
  test("needs the client id and a live token; answers with rate-limit headers", async () => {
    const tok = await issue();
    expect((await helix("users", "nope")).status).toBe(401);
    expect((await helix("users", tok, "other-client")).status).toBe(401);
    const res = await helix("users", tok);
    expect(res.headers.get("ratelimit-limit")).toBe("800");
    expect(Number(res.headers.get("ratelimit-reset"))).toBeGreaterThan(Date.now() / 1000);
    const users = (await res.json()) as { data: { id: string; description: string }[] };
    expect(users.data).toHaveLength(1);
    expect(users.data[0]).toMatchObject({ id: TWITCH_FIXTURE.userId, description: TWITCH_FIXTURE.description });
  });

  test("channels, emotes with CDN URLs on the public host, a paginated schedule", async () => {
    const tok = await issue();
    const ch = (await (await helix(`channels?broadcaster_id=${TWITCH_FIXTURE.userId}`, tok)).json()) as {
      data: { title: string; game_name: string }[];
    };
    expect(ch.data[0]).toMatchObject({ title: TWITCH_FIXTURE.title, game_name: TWITCH_FIXTURE.category });
    const em = (await (await helix(`chat/emotes?broadcaster_id=${TWITCH_FIXTURE.userId}`, tok)).json()) as {
      data: { name: string; images: { url_4x: string } }[];
      template: string;
    };
    expect(em.data.map((e) => e.name)).toEqual(["pgWave", "pgHype", "pgHi", "pgBad", "pgBits"]);
    expect(em.data[0]?.images.url_4x.startsWith(`${mock.cdnBase}/emoticons/v2/`)).toBe(true);
    expect(em.template).not.toContain("{{cdn}}");
    const p1 = (await (await helix(`schedule?broadcaster_id=${TWITCH_FIXTURE.userId}&first=25`, tok)).json()) as {
      data: { segments: unknown[] };
      pagination: { cursor?: string };
    };
    expect(p1.data.segments).toHaveLength(2);
    const p2 = (await (
      await helix(`schedule?broadcaster_id=${TWITCH_FIXTURE.userId}&first=25&after=${p1.pagination.cursor}`, tok)
    ).json()) as { data: { segments: unknown[] }; pagination: { cursor?: string } };
    expect(p2.data.segments).toHaveLength(TWITCH_FIXTURE.scheduleSegments - 2);
    expect(p2.pagination.cursor).toBeUndefined();
    expect((await helix(`schedule?broadcaster_id=${TWITCH_FIXTURE.otherUserId}`, tok)).status).toBe(404);
  });

  test("helixStatus and channelOverride script failures", async () => {
    const tok = await issue();
    mock.helixStatus = 503;
    expect((await helix("users", tok)).status).toBe(503);
    mock.helixStatus = null;
    mock.channelOverride = { broadcaster_id: "1", broadcaster_login: "x" };
    const ch = (await (await helix(`channels?broadcaster_id=${TWITCH_FIXTURE.userId}`, tok)).json()) as {
      data: { broadcaster_id: string }[];
    };
    expect(ch.data[0]?.broadcaster_id).toBe("1");
    mock.channelOverride = null;
  });
});

describe("the CDN", () => {
  test("generated PNGs per emote, the T0 fixture for pgBad, 404 otherwise", async () => {
    const wave = await fetch(`${mock.cdnBase}/emoticons/v2/emotesv2_pgwave/static/light/3.0`);
    expect(wave.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await wave.arrayBuffer()).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const bad = await fetch(`${mock.cdnBase}/emoticons/v2/${TWITCH_FIXTURE.t0EmoteId}/static/light/3.0`);
    expect([...new Uint8Array(await bad.arrayBuffer())]).toEqual([...T0]);
    expect((await fetch(`${mock.cdnBase}/emoticons/v2/nope/static/light/3.0`)).status).toBe(404);
  });

  test("without the T0 fixture, pgBad has no image", async () => {
    const bare = await startTwitchMock({ hostname: "127.0.0.1" });
    try {
      expect((await fetch(`${bare.cdnBase}/emoticons/v2/${TWITCH_FIXTURE.t0EmoteId}/static/light/3.0`)).status).toBe(
        404,
      );
    } finally {
      await bare.close();
    }
  });
});

describe("the scenario", () => {
  test("every step has a runner; the mock port is the overlay's", () => {
    for (const n of TWITCH_IMPORT_STEP_NUMBERS) expect(typeof TWITCH_IMPORT_STEP_RUNNERS[n]).toBe("function");
    expect(TWITCH_MOCK_PORT).toBe(4791);
  });

  test("step 7's expected panels are what panelPaste makes of the paste", () => {
    expect(panelPaste(PANEL_PASTE)).toEqual(PANEL_EXPECTED);
  });
});
