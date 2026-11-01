// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The in-harness Twitch mock (N3, ADR 0031): one `Bun.serve` that plays Twitch's OAuth host, Helix
 * and the emote CDN, from fixtures of a made-up channel (`fixtures/*.json`, CC0). The real Twitch
 * API is never called by tests or the harness.
 *
 * - `GET /oauth2/authorize` records the request and redirects back with a one-time code (or
 *   `error=access_denied` while `deny` is set). The code authorizes `authorizeAs` (default the
 *   fixture channel's login).
 * - `POST /oauth2/token` checks the client, secret, code and redirect URI and issues a token;
 *   `GET /oauth2/validate` and `POST /oauth2/revoke` (recorded in `revocations`).
 * - Helix `GET /helix/users`, `/channels`, `/chat/emotes`, `/schedule` (paginated by `first` and
 *   `after`), each needing the client id and a live token, with rate-limit headers.
 * - `GET /cdn/emoticons/v2/<id>/…` serves PNG bytes: a generated test card per emote, and the T0
 *   fixture image (when given) for `pgBad`.
 *
 * Self-contained (Bun, node:zlib through `png.ts`), so the API's and the worker's integration
 * tests run the same mock. Reachability from the containers works as in the e9 receiver: it
 * listens on all interfaces, and `publicHost` is the name the containers use
 * (`host.containers.internal`), which also builds the CDN URLs Helix answers with.
 */
import type { Server } from "bun";
import { testCardPng } from "../../png.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);

/** The fixture accounts. */
export const TWITCH_FIXTURE = {
  login: "pixelgardener",
  userId: "90000001",
  displayName: "PixelGardener",
  title: "Planting sprites until the sun comes up",
  category: "Pixel Art Gardening",
  description: "Cozy pixel-art gardening streams. Seeds, sprites and slow mornings.",
  /** Offered emotes, with their CommonAir tiers. */
  emotes: { pgWave: 1, pgHype: 2, pgHi: 0, pgBad: 3 } as Record<string, number>,
  /** The emote whose image is the T0 fixture. */
  t0Emote: "pgBad",
  t0EmoteId: "emotesv2_pgbad",
  bitsEmote: "pgBits",
  scheduleSegments: 3,
  /** A second account, for the account-mismatch checks. */
  otherLogin: "otherfixture",
  otherUserId: "90000002",
} as const;

export interface MockRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  at: number;
}

export interface TwitchMockOptions {
  /** 0 picks a free port (tests); the harness uses `TWITCH_MOCK_PORT`. */
  port?: number;
  /** Default `0.0.0.0`, so the stack's containers reach it. */
  hostname?: string;
  /** The host the CDN URLs name (as the worker reaches it). Default `127.0.0.1`. */
  publicHost?: string;
  clientId?: string;
  clientSecret?: string;
  /** The T0 fixture's bytes, served for `pgBad`; without it that image answers 404. */
  t0Image?: Uint8Array;
  /** Helix page size cap for `/schedule` (Helix's is 25). */
  maxPage?: number;
}

export interface TwitchMock {
  port: number;
  /** `http://127.0.0.1:<port>` (this machine). */
  origin: string;
  /** `http://<publicHost>:<port>/helix`, `/oauth2`, `/cdn`. */
  apiBase: string;
  authBase: string;
  cdnBase: string;
  clientId: string;
  clientSecret: string;
  readonly requests: readonly MockRequest[];
  /** Tokens revoked through `/oauth2/revoke`, in order. */
  readonly revocations: readonly string[];
  /** Every token issued, in order. */
  readonly issued: readonly string[];
  /** Authorize requests' query strings. */
  readonly authorizations: readonly Record<string, string>[];
  /** Which fixture login the next authorization proves. */
  authorizeAs: string;
  /** While set, the authorize endpoint redirects back with `error=access_denied`. */
  deny: boolean;
  /** Helix answers this status instead (to test failures); null for normal answers. */
  helixStatus: number | null;
  /** Override what `/helix/channels` answers for the next calls (a different broadcaster, say). */
  channelOverride: Record<string, unknown> | null;
  /** The emote image bytes the CDN serves, by Twitch emote id. */
  readonly images: ReadonlyMap<string, Uint8Array>;
  close(): Promise<void>;
}

type Json = Record<string, unknown>;

async function fixture<T>(name: string): Promise<T> {
  return (await Bun.file(new URL(name, FIXTURES)).json()) as T;
}

const fillCdn = <T>(value: T, cdn: string): T => JSON.parse(JSON.stringify(value).replaceAll("{{cdn}}", cdn)) as T;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export async function startTwitchMock(opts: TwitchMockOptions = {}): Promise<TwitchMock> {
  const clientId = opts.clientId ?? "harness-twitch-client-id";
  const clientSecret = opts.clientSecret ?? "harness-twitch-client-secret";
  const publicHost = opts.publicHost ?? "127.0.0.1";
  const maxPage = opts.maxPage ?? 25;

  const usersFx = await fixture<{ data: Json[] }>("users.json");
  const channelsFx = await fixture<{ data: Json[] }>("channels.json");
  const emotesFx = await fixture<Record<string, { data: Json[]; template: string }>>("emotes.json");
  const scheduleFx = await fixture<Record<string, Json[]>>("schedule.json");

  const requests: MockRequest[] = [];
  const revocations: string[] = [];
  const issued: string[] = [];
  const authorizations: Record<string, string>[] = [];
  /** code → {login, redirectUri}; one use. */
  const codes = new Map<string, { login: string; redirectUri: string }>();
  /** live token → login. */
  const tokens = new Map<string, string>();
  const images = new Map<string, Uint8Array>();
  for (const [i, e] of (emotesFx[TWITCH_FIXTURE.userId]?.data ?? []).entries()) {
    const id = String(e.id);
    if (id === TWITCH_FIXTURE.t0EmoteId) {
      if (opts.t0Image) images.set(id, opts.t0Image);
    } else images.set(id, testCardPng(48 + i * 8));
  }

  const userByLogin = (login: string) => usersFx.data.find((u) => u.login === login) ?? null;
  let resetAt = Math.floor(Date.now() / 1000) + 60;
  let remaining = 800;
  const rateHeaders = () => {
    const now = Math.floor(Date.now() / 1000);
    if (now >= resetAt) {
      resetAt = now + 60;
      remaining = 800;
    }
    remaining = Math.max(0, remaining - 1);
    return { "ratelimit-limit": "800", "ratelimit-remaining": String(remaining), "ratelimit-reset": String(resetAt) };
  };

  let mock: TwitchMock;
  const server: Server<undefined> = Bun.serve({
    hostname: opts.hostname ?? "0.0.0.0",
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), at: Date.now() });
      const cdn = mock.cdnBase;

      // OAuth ------------------------------------------------------------------------------
      if (path === "/oauth2/authorize" && req.method === "GET") {
        const q = Object.fromEntries(url.searchParams);
        authorizations.push(q);
        const redirect = q.redirect_uri;
        if (!redirect || q.client_id !== clientId) return json({ status: 400, message: "invalid client" }, 400);
        const back = new URL(redirect);
        if (q.state !== undefined) back.searchParams.set("state", q.state);
        if (mock.deny) {
          back.searchParams.set("error", "access_denied");
          back.searchParams.set("error_description", "The user denied you access");
        } else {
          const code = `mock-code-${crypto.randomUUID()}`;
          codes.set(code, { login: mock.authorizeAs, redirectUri: redirect });
          back.searchParams.set("code", code);
          back.searchParams.set("scope", q.scope ?? "");
        }
        return new Response(null, { status: 302, headers: { location: back.toString() } });
      }
      if (path === "/oauth2/token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        const grant = codes.get(form.get("code") ?? "");
        if (
          form.get("client_id") !== clientId ||
          form.get("client_secret") !== clientSecret ||
          form.get("grant_type") !== "authorization_code" ||
          !grant ||
          grant.redirectUri !== form.get("redirect_uri")
        )
          return json({ status: 400, message: "Invalid authorization code" }, 400);
        codes.delete(form.get("code") ?? "");
        const token = `mock-token-${crypto.randomUUID().replace(/-/g, "")}`;
        tokens.set(token, grant.login);
        issued.push(token);
        return json({
          access_token: token,
          expires_in: 14_000,
          refresh_token: `mock-refresh-${token}`,
          scope: [],
          token_type: "bearer",
        });
      }
      if (path === "/oauth2/validate" && req.method === "GET") {
        const token = /^OAuth\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
        const login = tokens.get(token);
        const user = login ? userByLogin(login) : null;
        if (!user) return json({ status: 401, message: "invalid access token" }, 401);
        return json({ client_id: clientId, login: user.login, user_id: user.id, scopes: [], expires_in: 13_000 });
      }
      if (path === "/oauth2/revoke" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        const token = form.get("token") ?? "";
        if (form.get("client_id") !== clientId || !tokens.has(token))
          return json({ status: 400, message: "Invalid token" }, 400);
        tokens.delete(token);
        revocations.push(token);
        return new Response(null, { status: 200 });
      }

      // Helix ------------------------------------------------------------------------------
      if (path.startsWith("/helix/")) {
        const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
        const login = tokens.get(token);
        if (req.headers.get("client-id") !== clientId || !login)
          return json({ error: "Unauthorized", status: 401, message: "Invalid OAuth token" }, 401);
        const headers = rateHeaders();
        if (mock.helixStatus !== null)
          return json({ error: "Mock", status: mock.helixStatus }, mock.helixStatus, headers);
        const broadcaster = url.searchParams.get("broadcaster_id") ?? "";
        if (path === "/helix/users") {
          const u = userByLogin(login);
          return json({ data: u ? [fillCdn(u, cdn)] : [] }, 200, headers);
        }
        if (path === "/helix/channels") {
          if (mock.channelOverride) return json({ data: [mock.channelOverride] }, 200, headers);
          return json({ data: channelsFx.data.filter((c) => c.broadcaster_id === broadcaster) }, 200, headers);
        }
        if (path === "/helix/chat/emotes") {
          const e = emotesFx[broadcaster] ?? { data: [], template: "" };
          return json(fillCdn(e, cdn), 200, headers);
        }
        if (path === "/helix/schedule") {
          const all = scheduleFx[broadcaster] ?? [];
          if (all.length === 0)
            return json({ error: "Not Found", status: 404, message: "segments not found" }, 404, headers);
          const first = Math.min(maxPage, Math.max(1, Number(url.searchParams.get("first") ?? 20) || 20));
          const start = Number(url.searchParams.get("after") ?? 0) || 0;
          const page = all.slice(start, start + first);
          const next = start + first < all.length ? String(start + first) : undefined;
          return json(
            {
              data: { segments: fillCdn(page, cdn), broadcaster_id: broadcaster, vacation: null },
              pagination: next ? { cursor: next } : {},
            },
            200,
            headers,
          );
        }
        return json({ error: "Not Found", status: 404 }, 404, headers);
      }

      // The CDN ----------------------------------------------------------------------------
      const m = /^\/cdn\/emoticons\/v2\/([^/]+)\//.exec(path);
      if (m && req.method === "GET") {
        const bytes = images.get(decodeURIComponent(m[1] ?? ""));
        if (!bytes) return new Response("not found", { status: 404 });
        return new Response(Buffer.from(bytes), { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const port = server.port ?? 0;
  const hostBase = `http://${publicHost}:${port}`;
  mock = {
    port,
    origin: `http://127.0.0.1:${port}`,
    apiBase: `${hostBase}/helix`,
    authBase: `${hostBase}/oauth2`,
    cdnBase: `${hostBase}/cdn`,
    clientId,
    clientSecret,
    requests,
    revocations,
    issued,
    authorizations,
    authorizeAs: TWITCH_FIXTURE.login,
    deny: false,
    helixStatus: null,
    channelOverride: null,
    images,
    async close() {
      await server.stop(true);
    },
  };
  return mock;
}
