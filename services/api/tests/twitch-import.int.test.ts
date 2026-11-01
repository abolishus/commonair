// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * N3-import, the API's half, against the in-harness Twitch mock (never the real Twitch API):
 *
 * - unavailable without the credentials, and with the flag off (status, connect, the callback);
 * - the authorize URL requests no scopes and carries a session-bound state;
 * - the callback reads the fixture channel into a `previewed` import and revokes the token; the
 *   token appears in no stored row and no log line;
 * - a replayed, forged, expired or other-session state is refused; a denied authorization stores
 *   nothing;
 * - an account mismatch (the member's linked Twitch identity, or a channel read back for another
 *   broadcaster) is refused, and the token is still revoked;
 * - the preview expires after an hour; start needs the art assertion for emotes, records it and
 *   queues the job.
 */
import { createLogger } from "@commonair/observability";
import { schema, uuidv7 } from "@commonair/db";
import { EMOTE_ASSERTION_VERSION } from "@commonair/twitch";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { startTwitchMock, TWITCH_FIXTURE, type TwitchMock } from "../../../harness/src/mocks/twitch/server.ts";
import { setTwitchImportQueue } from "../src/twitch-import/queue.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
let mock: TwitchMock;
const logLines: string[] = [];
const enqueued: string[] = [];
type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface ImportDto {
  id: string;
  source: string;
  status: string;
  preview: {
    channel: Record<string, unknown>;
    items: { kind: string; ref: string; outcome: string | null; reason: string | null }[];
  };
  assertedAt: string | null;
}

beforeAll(async () => {
  mock = await startTwitchMock({ hostname: "127.0.0.1" });
  api = await startApi({
    env: {
      TWITCH_IMPORT_ENABLED: "true",
      OAUTH_TWITCH_CLIENT_ID: mock.clientId,
      OAUTH_TWITCH_CLIENT_SECRET: mock.clientSecret,
      TWITCH_API_BASE_URL: mock.apiBase,
      TWITCH_AUTH_BASE_URL: mock.authBase,
      LOG_LEVEL: "debug",
    },
  });
  // Capture every log line the API writes while these tests run (grepped for tokens below).
  (api.deps as { logger: unknown }).logger = createLogger({
    service: "api-test",
    level: "debug",
    write: (l) => logLines.push(l),
  });
  setTwitchImportQueue(api.deps, {
    enqueue: async (id) => {
      enqueued.push(id);
    },
  });
}, 120_000);

afterAll(async () => {
  await api?.stop();
  await mock?.close();
});

beforeEach(() => {
  mock.authorizeAs = TWITCH_FIXTURE.login;
  mock.deny = false;
  mock.helixStatus = null;
  mock.channelOverride = null;
});

async function withEnv(patch: Record<string, unknown>, fn: () => Promise<void>) {
  const env = api.deps.env as unknown as Record<string, unknown>;
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, env[k]]));
  Object.assign(env, patch);
  try {
    await fn();
  } finally {
    Object.assign(env, before);
  }
}

async function withNow(at: Date, fn: () => Promise<void>) {
  const before = api.deps.now;
  api.deps.now = () => at;
  try {
    await fn();
  } finally {
    api.deps.now = before;
  }
}

const base = (u: User) => `/api/channels/${u.username}/twitch-import`;

async function connectUrl(u: User): Promise<URL> {
  const r = await u.client.call<{ authorizeUrl: string }>("POST", `${base(u)}/connect`, {});
  expect(r.status).toBe(200);
  return new URL(r.body.authorizeUrl);
}

/** Follow the authorize redirect at the mock: the callback URL it sends the browser to. */
async function authorize(url: URL): Promise<URL> {
  const res = await fetch(url, { redirect: "manual" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "");
}

/** Call the callback as the browser would (with `u`'s cookies, or none); the outcome it redirects with. */
async function callback(cb: URL, u: User | null): Promise<string> {
  const res = await fetch(`${api.url}${cb.pathname}${cb.search}`, {
    redirect: "manual",
    headers: u ? { cookie: u.client.jar.header() } : {},
  });
  expect(res.status).toBe(303);
  const to = new URL(res.headers.get("location") ?? "");
  expect(to.pathname).toBe("/import");
  return to.searchParams.get("twitch") ?? "";
}

async function connectAll(u: User): Promise<string> {
  return callback(await authorize(await connectUrl(u)), u);
}

const rowsOf = async (u: User) => {
  const [c] = await api.db.db.select().from(schema.channels).where(eq(schema.channels.ownerId, u.userId));
  return api.db.db.select().from(schema.portabilityImports).where(eq(schema.portabilityImports.channelId, c!.id));
};

describe("availability", () => {
  test("unavailable without credentials, and with the flag off", async () => {
    const u = await signUpAndSignIn(api);
    for (const patch of [
      { OAUTH_TWITCH_CLIENT_ID: undefined, OAUTH_TWITCH_CLIENT_SECRET: undefined },
      { OAUTH_TWITCH_CLIENT_SECRET: undefined },
      { TWITCH_IMPORT_ENABLED: false },
    ])
      await withEnv(patch, async () => {
        const s = await u.client.call<{ available: boolean; connected: boolean }>("GET", base(u));
        expect([s.status, s.body.available, s.body.connected]).toEqual([200, false, false]);
        const c = await u.client.call("POST", `${base(u)}/connect`, {});
        expect(c.status).toBe(412);
        const p = await u.client.call("POST", `${base(u)}/preview`, {});
        expect(p.status).toBe(412);
        expect((await fetch(`${api.url}/api/twitch-import/callback?code=x&state=y`)).status).toBe(404);
        const info = await client(api).call<{ features: { twitchImport: boolean } }>("GET", "/api/instance");
        expect(info.body.features.twitchImport).toBe(false);
      });
    const s = await u.client.call<{ available: boolean }>("GET", base(u));
    expect(s.body.available).toBe(true);
  });

  test("only the owner, and only from a signed-in browser session", async () => {
    const [owner, other] = [await signUpAndSignIn(api), await signUpAndSignIn(api)];
    expect((await other.client.call("GET", base(owner))).status).toBe(403);
    expect((await other.client.call("POST", `${base(owner)}/connect`, {})).status).toBe(403);
  });
});

describe("connect and the callback", () => {
  test("no scopes are requested; the fixture channel is previewed; the token is revoked", async () => {
    const u = await signUpAndSignIn(api);
    const url = await connectUrl(u);
    expect(url.origin + url.pathname).toBe(`${mock.authBase}/authorize`);
    expect(url.searchParams.getAll("scope")).toEqual([""]);
    expect(url.searchParams.get("redirect_uri")).toBe(`${api.url}/api/twitch-import/callback`);
    expect(url.searchParams.get("client_id")).toBe(mock.clientId);
    expect(url.searchParams.get("response_type")).toBe("code");
    const issuedBefore = mock.issued.length;
    expect(await callback(await authorize(url), u)).toBe("connected");
    expect(mock.authorizations.at(-1)?.scope).toBe("");

    // One token issued, and revoked after the read.
    expect(mock.issued.length).toBe(issuedBefore + 1);
    const token = mock.issued.at(-1)!;
    expect(mock.revocations).toContain(token);
    const revokedAt = mock.requests.findLastIndex((r) => r.path === "/oauth2/revoke");
    const lastRead = mock.requests.findLastIndex((r) => r.path.startsWith("/helix/"));
    expect(revokedAt).toBeGreaterThan(lastRead);

    const s = await u.client.call<{ available: boolean; connected: boolean; twitchLogin: string; latest: ImportDto }>(
      "GET",
      base(u),
    );
    expect(s.body).toMatchObject({ available: true, connected: true, twitchLogin: TWITCH_FIXTURE.login });
    const p = await u.client.call<ImportDto>("POST", `${base(u)}/preview`, {});
    expect(p.status).toBe(200);
    expect(p.body.source).toBe("twitch");
    expect(p.body.status).toBe("previewed");
    expect(p.body.preview.channel).toMatchObject({
      state: "ready",
      twitchLogin: TWITCH_FIXTURE.login,
      title: TWITCH_FIXTURE.title,
      category: TWITCH_FIXTURE.category,
      description: TWITCH_FIXTURE.description,
      tags: ["pixelart", "cozy", "gardening"],
      language: "en",
      matureSuggested: true,
    });
    expect((p.body.preview.channel.schedule as unknown[]).length).toBe(TWITCH_FIXTURE.scheduleSegments);
    expect(Date.parse(String(p.body.preview.channel.expiresAt))).toBeGreaterThan(Date.now() + 55 * 60_000);
    const emotes = p.body.preview.items.filter((i) => i.kind === "emote");
    expect(emotes.filter((e) => e.outcome === null).map((e) => e.ref)).toEqual(["pgWave", "pgHype", "pgHi", "pgBad"]);
    expect(emotes.find((e) => e.ref === TWITCH_FIXTURE.bitsEmote)).toMatchObject({
      outcome: "skipped",
      reason: "bits_emote",
    });
    expect(p.body.preview.items.find((i) => i.kind === "schedule")).toMatchObject({ reason: "carried_not_applied" });

    // The schedule was read across pages (first=25 on Helix; one page here).
    expect(
      mock.requests.some((r) => r.path === "/helix/schedule" && r.query.broadcaster_id === TWITCH_FIXTURE.userId),
    ).toBe(true);

    // The token is nowhere: not in the stored rows, not in the audit log or outbox, not in a log line.
    const dump = JSON.stringify([
      await api.db.db.select().from(schema.portabilityImports),
      await api.db.db.select().from(schema.auditLog),
      await api.db.db.select().from(schema.events),
      await api.db.db.select().from(schema.accounts),
    ]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain("mock-refresh-");
    expect(logLines.join("\n")).not.toContain(token);
    expect(logLines.some((l) => l.includes("twitch import previewed"))).toBe(true);
  });

  test("a second authorization replaces an unstarted preview", async () => {
    const u = await signUpAndSignIn(api);
    expect(await connectAll(u)).toBe("connected");
    expect(await connectAll(u)).toBe("connected");
    expect((await rowsOf(u)).filter((r) => r.status === "previewed")).toHaveLength(1);
  });

  test("a replayed state is refused", async () => {
    const u = await signUpAndSignIn(api);
    const cb = await authorize(await connectUrl(u));
    expect(await callback(cb, u)).toBe("connected");
    const revokes = mock.revocations.length;
    expect(await callback(cb, u)).toBe("invalid");
    // The replay never reached Twitch.
    expect(mock.revocations.length).toBe(revokes);
  });

  test("a forged, tampered, expired or other-session state is refused", async () => {
    const u = await signUpAndSignIn(api);
    const other = await signUpAndSignIn(api);
    const cb = await authorize(await connectUrl(u));
    const state = cb.searchParams.get("state")!;
    const withState = (s: string) => {
      const x = new URL(cb);
      x.searchParams.set("state", s);
      return x;
    };
    const [body, sig] = state.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), u: other.userId }),
    ).toString("base64url");
    expect(await callback(withState(`${forgedBody}.${sig}`), u)).toBe("invalid");
    expect(await callback(withState(`${body}.${"A".repeat(43)}`), u)).toBe("invalid");
    expect(await callback(withState("not-a-state"), u)).toBe("invalid");
    const nostate = new URL(cb);
    nostate.searchParams.delete("state");
    expect(await callback(nostate, u)).toBe("invalid");
    // Another member's session, or no session at all.
    expect(await callback(cb, other)).toBe("invalid");
    expect(await callback(cb, null)).toBe("invalid");
    // The same member signed in again: a different session.
    const again = client(api);
    await again.call("POST", "/api/auth/sign-in/email", { email: u.email, password: u.password });
    const res = await fetch(`${api.url}${cb.pathname}${cb.search}`, {
      redirect: "manual",
      headers: { cookie: again.jar.header() },
    });
    expect(new URL(res.headers.get("location")!).searchParams.get("twitch")).toBe("invalid");
    // Expired: eleven minutes later.
    const late = await authorize(await connectUrl(u));
    await withNow(new Date(Date.now() + 11 * 60_000), async () => {
      expect(await callback(late, u)).toBe("invalid");
    });
    // Nothing was stored by any of these.
    expect(await rowsOf(u)).toHaveLength(0);
  });

  test("a denied authorization stores nothing and issues no token", async () => {
    const u = await signUpAndSignIn(api);
    mock.deny = true;
    const issued = mock.issued.length;
    expect(await connectAll(u)).toBe("denied");
    expect(mock.issued.length).toBe(issued);
    expect(await rowsOf(u)).toHaveLength(0);
  });

  test("account mismatch: the member's linked Twitch identity is another account", async () => {
    const u = await signUpAndSignIn(api);
    await api.db.db.insert(schema.accounts).values({
      id: uuidv7(),
      userId: u.userId,
      accountId: TWITCH_FIXTURE.userId,
      providerId: "twitch",
    });
    mock.authorizeAs = TWITCH_FIXTURE.otherLogin;
    expect(await connectAll(u)).toBe("mismatch");
    expect(mock.revocations).toContain(mock.issued.at(-1));
    expect(await rowsOf(u)).toHaveLength(0);
    // The linked account itself imports.
    mock.authorizeAs = TWITCH_FIXTURE.login;
    expect(await connectAll(u)).toBe("connected");
  });

  test("account mismatch: Helix answers another broadcaster's channel", async () => {
    const u = await signUpAndSignIn(api);
    mock.channelOverride = {
      broadcaster_id: TWITCH_FIXTURE.otherUserId,
      broadcaster_login: TWITCH_FIXTURE.otherLogin,
      title: "not yours",
    };
    expect(await connectAll(u)).toBe("mismatch");
    expect(mock.revocations).toContain(mock.issued.at(-1));
    expect(await rowsOf(u)).toHaveLength(0);
  });

  test("a Helix failure stores nothing, and the token is still revoked", async () => {
    const u = await signUpAndSignIn(api);
    mock.helixStatus = 500;
    expect(await connectAll(u)).toBe("failed");
    expect(mock.revocations).toContain(mock.issued.at(-1));
    expect(await rowsOf(u)).toHaveLength(0);
    expect(logLines.join("\n")).not.toContain(mock.issued.at(-1)!);
  });
});

describe("preview expiry and start", () => {
  test("the preview expires after an hour", async () => {
    const u = await signUpAndSignIn(api);
    expect(await connectAll(u)).toBe("connected");
    const p = await u.client.call<ImportDto>("POST", `${base(u)}/preview`, {});
    await withNow(new Date(Date.now() + 61 * 60_000), async () => {
      const again = await u.client.call<{ data?: { reason?: string } }>("POST", `${base(u)}/preview`, {});
      expect([again.status, again.body.data?.reason]).toEqual([404, "preview_expired"]);
      const s = await u.client.call<{ connected: boolean; latest: ImportDto }>("GET", base(u));
      expect(s.body.connected).toBe(false);
      expect(s.body.latest.preview.channel.state).toBe("expired");
      const start = await u.client.call<{ data?: { reason?: string } }>("POST", `${base(u)}/${p.body.id}/start`, {
        choices: { channel: true, panels: false, emotes: [] },
      });
      expect([start.status, start.body.data?.reason]).toEqual([409, "preview_expired"]);
    });
  });

  test("emotes need the art assertion; start records it and queues the job", async () => {
    const u = await signUpAndSignIn(api);
    expect(await connectAll(u)).toBe("connected");
    const p = await u.client.call<ImportDto>("POST", `${base(u)}/preview`, {});
    const choices = { channel: true, panels: true, emotes: ["pgWave", "pgHi", "pgBits", "nope"] };
    const refused = await u.client.call<{ data?: { requirement?: string } }>("POST", `${base(u)}/${p.body.id}/start`, {
      choices,
    });
    expect([refused.status, refused.body.data?.requirement]).toEqual([412, "emote_rights"]);
    expect(enqueued).not.toContain(p.body.id);

    const ok = await u.client.call<ImportDto>("POST", `${base(u)}/${p.body.id}/start`, {
      choices,
      assertEmoteRights: true,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("queued");
    expect(ok.body.assertedAt).not.toBeNull();
    expect(enqueued).toContain(p.body.id);
    const [row] = (await rowsOf(u)).filter((r) => r.id === p.body.id);
    // Only offered emotes are kept; panels never come from Twitch.
    expect(row?.choices).toEqual({ channel: true, panels: false, emotes: ["pgWave", "pgHi"] });
    expect(row?.assertionVersion).toBe(EMOTE_ASSERTION_VERSION);
    const [a] = await api.db.db.select().from(schema.auditLog).where(eq(schema.auditLog.subjectId, p.body.id));
    expect(a?.action).toBe("twitch_import.start");

    const twice = await u.client.call("POST", `${base(u)}/${p.body.id}/start`, { choices, assertEmoteRights: true });
    expect(twice.status).toBe(409);
  });

  test("the generic portability start refuses a Twitch preview", async () => {
    const u = await signUpAndSignIn(api);
    expect(await connectAll(u)).toBe("connected");
    const p = await u.client.call<ImportDto>("POST", `${base(u)}/preview`, {});
    const generic = await u.client.call("POST", `/api/channels/${u.username}/imports/${p.body.id}/start`, {
      choices: { channel: true, panels: true, emotes: [] },
    });
    expect(generic.status).toBe(409);
    const [row] = (await rowsOf(u)).filter((r) => r.id === p.body.id);
    expect(row?.status).toBe("previewed");
    expect(enqueued).not.toContain(p.body.id);
    // The Twitch start still works afterwards: nothing was left queued.
    const ok = await u.client.call<ImportDto>("POST", `${base(u)}/${p.body.id}/start`, {
      choices: { channel: true, panels: false, emotes: [] },
    });
    expect(ok.status).toBe(200);
  });

  test("channel fields only need no assertion", async () => {
    const u = await signUpAndSignIn(api);
    expect(await connectAll(u)).toBe("connected");
    const p = await u.client.call<ImportDto>("POST", `${base(u)}/preview`, {});
    const ok = await u.client.call<ImportDto>("POST", `${base(u)}/${p.body.id}/start`, {
      choices: { channel: true, panels: false, emotes: [] },
    });
    expect([ok.status, ok.body.assertedAt]).toEqual([200, null]);
  });
});
