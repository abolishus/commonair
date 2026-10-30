// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer-platform` step 2 (E9-oauth; docs/testing/e9-selectors.md "Scenarios"): the streamer
 * authorizes the confidential app over the API with PKCE `S256`; a wrong verifier and a code used
 * twice are `invalid_grant` (the second use revokes the first redemption's family); refresh
 * rotates and replaying the old refresh token revokes the family; the streamer re-authorizes
 * (that grant is `state.grant`). Device flow with the public app (`authorization_pending`,
 * `slow_down`, approve, token). Client credentials (`state.appToken`): `oauth2/validate` shows no
 * user and no scopes, `chat.send` refuses it. `oauth2/revoke` on a refresh token kills its family.
 * Reports ids and outcomes only: never a token, code, verifier or secret.
 */
import {
  DEVICE_CODE_GRANT,
  OAUTH_PATHS,
  PKCE_CHALLENGE,
  PKCE_VERIFIER,
  pkceChallenge,
} from "@commonair/contracts/oauth";
import type { Scope } from "@commonair/contracts/scopes";
import { createApi } from "../api/client.ts";
import type { SignedInUser } from "../users.ts";
import { sleep } from "../wait.ts";
import { type E9App, type E9Run, type E9Step, authorizeOverApi, machineFetch } from "./run.ts";

/** Past `REFRESH_REUSE_GRACE_MS` (2 s, services/api/src/oauth/tokens.ts). */
const REFRESH_REPLAY_AFTER_MS = 2500;

/** Step 5 subscribes polls and points with this grant (E8's EventSub delivery check). */
export const STEP2_SCOPES: readonly Scope[] = [
  "chat:read",
  "channel:read:subscriptions",
  "channel:manage:polls",
  "channel:read:points",
];

/** An RFC 7636 verifier (64 unreserved characters) and its S256 challenge. */
export async function newPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64url");
  return { verifier, challenge: await pkceChallenge(verifier) };
}

export const isPkcePair = (p: { verifier: string; challenge: string }) =>
  PKCE_VERIFIER.test(p.verifier) && PKCE_CHALLENGE.test(p.challenge);

export type RedirectOutcome = { kind: "code"; code: string } | { kind: "error"; error: string };

/**
 * What the app's redirect URI received: a code or an error, with the state checked. A missing or
 * different state, or neither a code nor an error, throws (the flow is broken, not refused).
 */
export function parseRedirect(redirectTo: string, expected: { redirectUri: string; state: string }): RedirectOutcome {
  const url = new URL(redirectTo);
  const base = new URL(expected.redirectUri);
  if (url.origin !== base.origin || url.pathname !== base.pathname)
    throw new Error("redirect: not sent back to the registered redirect URI");
  if (url.searchParams.get("state") !== expected.state) throw new Error("redirect: state did not round-trip");
  const error = url.searchParams.get("error");
  if (error) return { kind: "error", error };
  const code = url.searchParams.get("code");
  if (!code) throw new Error("redirect: neither code nor error");
  return { kind: "code", code };
}

export interface TokenAnswer {
  status: number;
  /** RFC 6749 §5.2 `error`, when refused. */
  error: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  /** RFC 8628 `interval` etc. come back on the device endpoint only. */
  body: Record<string, unknown>;
}

/** POST a form to one of the machine endpoints. The body is returned to the caller, never logged. */
export async function postForm(
  run: Pick<E9Run, "env"> & { platform?: Pick<E9Run["platform"], "api"> },
  path: string,
  params: Record<string, string>,
): Promise<TokenAnswer> {
  const request = new Request(new URL(path, run.env.HARNESS_API_URL), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const res = await (run.platform ? machineFetch(run.platform)(request) : fetch(request));
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Not JSON: keep the status only.
  }
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : null);
  return {
    status: res.status,
    error: str("error"),
    accessToken: str("access_token"),
    refreshToken: str("refresh_token"),
    body,
  };
}

const clientParams = (app: E9App): Record<string, string> =>
  app.clientSecret === null
    ? { client_id: app.clientId }
    : { client_id: app.clientId, client_secret: app.clientSecret };

/** `GET /api/oauth2/validate` with a bearer: the HTTP status and the body. */
export async function validateToken(run: Pick<E9Run, "env">, token: string) {
  const res = await fetch(new URL(OAUTH_PATHS.validate, run.env.HARNESS_API_URL), {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = res.ok
    ? ((await res.json()) as { login: string | null; user_id: string | null; scopes: string[] })
    : null;
  return { status: res.status, body };
}

/** Consent through `developer.oauth.decide` with the actor's session; the code from the redirect. */
async function codeFor(app: E9App, actor: SignedInUser, scopes: readonly Scope[]) {
  const pkce = await newPkcePair();
  const state = crypto.randomUUID();
  const { redirectTo } = await actor.api.client.developer.oauth.decide({
    clientId: app.clientId,
    redirectUri: app.redirectUri,
    scope: scopes.join(" "),
    state,
    codeChallenge: pkce.challenge,
    codeChallengeMethod: "S256",
    approve: true,
  });
  const back = parseRedirect(redirectTo, { redirectUri: app.redirectUri, state });
  if (back.kind !== "code") throw new Error(`authorize: the app was sent back error=${back.error}`);
  return { code: back.code, verifier: pkce.verifier };
}

const exchange = (run: E9Run, app: E9App, c: { code: string; verifier: string }) =>
  postForm(run, OAUTH_PATHS.token, {
    grant_type: "authorization_code",
    code: c.code,
    redirect_uri: app.redirectUri,
    code_verifier: c.verifier,
    ...clientParams(app),
  });

const refresh = (run: E9Run, app: E9App, refreshToken: string) =>
  postForm(run, OAUTH_PATHS.token, { grant_type: "refresh_token", refresh_token: refreshToken, ...clientParams(app) });

/** The oRPC error code of an error, or null. */
const codeOf = (err: unknown): string | null => {
  const c = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof c === "string" ? c : null;
};

async function codeFlow(run: E9Run, app: E9App): Promise<void> {
  const { ctx } = run;
  const streamer = run.actors.streamer.user;

  const wrong = await codeFor(app, streamer, STEP2_SCOPES);
  const wrongAnswer = await exchange(run, app, { code: wrong.code, verifier: (await newPkcePair()).verifier });
  ctx.assert("2. a wrong PKCE verifier is invalid_grant", wrongAnswer.error === "invalid_grant", {
    status: wrongAnswer.status,
    error: wrongAnswer.error,
  });

  const twice = await codeFor(app, streamer, STEP2_SCOPES);
  const first = await exchange(run, app, twice);
  ctx.assert("2. the code exchanges once", first.status === 200 && first.accessToken !== null, {
    status: first.status,
  });
  const second = await exchange(run, app, twice);
  ctx.assert("2. the same code again is invalid_grant", second.error === "invalid_grant", { error: second.error });
  const firstFamily = await validateToken(run, first.accessToken ?? "");
  ctx.assert("2. code reuse revoked the first family", firstFamily.status === 401, { status: firstFamily.status });

  const grant = await authorizeOverApi(run, { app, actor: streamer, scopes: STEP2_SCOPES });
  const rotated = await refresh(run, app, grant.refreshToken);
  ctx.assert("2. refresh rotates", rotated.status === 200 && rotated.refreshToken !== null, { status: rotated.status });
  const oldAccess = await validateToken(run, grant.accessToken);
  ctx.check("2. the rotated access token stops validating", oldAccess.status === 401, { status: oldAccess.status });
  // A replay inside the API's 2 s reuse grace (a client retrying a lost response) is refused
  // without revoking anything; only a later replay is a theft signal.
  await sleep(REFRESH_REPLAY_AFTER_MS);
  const replay = await refresh(run, app, grant.refreshToken);
  ctx.assert("2. replaying the old refresh token is invalid_grant", replay.error === "invalid_grant", {
    error: replay.error,
  });
  const newest = await validateToken(run, rotated.accessToken ?? "");
  ctx.assert("2. the replay revoked the family: the newest access token fails validate", newest.status === 401, {
    status: newest.status,
  });

  run.state.grant = await authorizeOverApi(run, { app, actor: streamer, scopes: STEP2_SCOPES });
  const live = await validateToken(run, run.state.grant.accessToken);
  ctx.assert(
    "2. re-authorized: the grant validates with every scope",
    live.status === 200 &&
      live.body?.user_id === streamer.id &&
      STEP2_SCOPES.every((s) => live.body?.scopes.includes(s)),
    { status: live.status, scopes: live.body?.scopes },
  );
  ctx.data("oauth.grant", { userId: streamer.id, appId: app.id, scopes: run.state.grant.scopes });
}

async function deviceFlow(run: E9Run, app: E9App): Promise<void> {
  const { ctx } = run;
  const streamer = run.actors.streamer.user;
  const start = await postForm(run, OAUTH_PATHS.device, { scope: "chat:read chat:edit", ...clientParams(app) });
  ctx.assert("2. device authorization starts", start.status === 200, { status: start.status, error: start.error });
  const deviceCode = String(start.body.device_code);
  const userCode = String(start.body.user_code);
  const interval = Number(start.body.interval);
  const poll = () =>
    postForm(run, OAUTH_PATHS.token, { grant_type: DEVICE_CODE_GRANT, device_code: deviceCode, ...clientParams(app) });

  const pending = await poll();
  ctx.assert("2. device: authorization_pending", pending.error === "authorization_pending", { error: pending.error });
  const fast = await poll();
  ctx.assert("2. device: polling faster than interval is slow_down", fast.error === "slow_down", { error: fast.error });

  const lookup = await streamer.api.client.developer.oauth.activation({ userCode });
  ctx.assert("2. device: the user code looks up the public app", lookup.app.clientId === app.clientId, {
    appId: lookup.app.id,
  });
  await streamer.api.client.developer.oauth.activate({ userCode, approve: true });

  // slow_down added 5 s to the interval (RFC 8628 §3.5).
  await sleep((interval + 5 + 1) * 1000, ctx.signal);
  const token = await poll();
  ctx.assert("2. device: approved → token", token.status === 200 && token.refreshToken !== null, {
    status: token.status,
    error: token.error,
  });
  const v = await validateToken(run, token.accessToken ?? "");
  ctx.assert("2. device token validates as the streamer", v.status === 200 && v.body?.user_id === streamer.id, {
    status: v.status,
  });
}

async function clientCredentials(run: E9Run, app: E9App): Promise<void> {
  const { ctx } = run;
  const cc = await postForm(run, OAUTH_PATHS.token, { grant_type: "client_credentials", ...clientParams(app) });
  ctx.assert("2. client credentials issue an app token", cc.status === 200 && cc.accessToken !== null, {
    status: cc.status,
    error: cc.error,
  });
  const appToken = cc.accessToken ?? "";
  run.state.appToken = appToken;
  const v = await validateToken(run, appToken);
  ctx.assert(
    "2. app token: validate shows no user and no scopes",
    v.status === 200 && v.body?.login === null && v.body.user_id === null && v.body.scopes.length === 0,
    { status: v.status },
  );
  const asApp = createApi({ baseUrl: run.env.HARNESS_API_URL, bearer: appToken });
  let refused: string | null = null;
  try {
    await asApp.client.chat.send({ channel: run.actors.streamer.channel, body: "app token says hi" });
  } catch (err) {
    refused = codeOf(err);
  }
  ctx.assert("2. app token: chat.send is FORBIDDEN", refused === "FORBIDDEN", { code: refused });
}

async function revokeEndpoint(run: E9Run, app: E9App): Promise<void> {
  const { ctx } = run;
  const g = await authorizeOverApi(run, { app, actor: run.actors.streamer.user, scopes: ["chat:read"] });
  const rotated = await refresh(run, app, g.refreshToken);
  const res = await postForm(run, OAUTH_PATHS.revoke, {
    token: rotated.refreshToken ?? "",
    token_type_hint: "refresh_token",
    ...clientParams(app),
  });
  ctx.assert("2. oauth2/revoke answers 200", res.status === 200, { status: res.status });
  const v = await validateToken(run, rotated.accessToken ?? "");
  ctx.assert("2. revoking a refresh token kills its family", v.status === 401, { status: v.status });
  const kept = await validateToken(run, run.state.grant?.accessToken ?? "");
  ctx.assert("2. other grants of the app are untouched", kept.status === 200, { status: kept.status });
}

export const step: E9Step = {
  name: "oauth",
  owner: "E9-oauth",
  ready: true,
  needs: [1],
  async run(run) {
    const conf = run.state.confidentialApp;
    const pub = run.state.publicApp;
    if (!conf || !pub) throw new Error("step 2 needs step 1's apps");
    await codeFlow(run, conf);
    await deviceFlow(run, pub);
    await clientCredentials(run, conf);
    await revokeEndpoint(run, conf);
  },
};
