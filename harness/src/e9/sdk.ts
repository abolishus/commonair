// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer-platform` step 6 (E9-sdk; docs/testing/e9-selectors.md "Scenarios"): a bot built on
 * `@commonair/sdk` repeats steps 2, 4 and 5 through the SDK. PKCE through `createPkcePair` and
 * `authorizeUrl` (the streamer approves through `developer.oauth.decide`, as step 2 does), then
 * `exchangeCode`; an app token through `clientCredentials` subscribes a webhook (its own callback
 * query, so it does not collide with step 4's) and `verifyEventSubRequest` accepts the real
 * challenge; the EventSub client binds a session; `refreshingToken` rotates once while the session
 * stays bound, and the new token subscribes again on it; the viewer follows → one WebSocket
 * `notification` and a webhook delivery that verifies, and fails with one byte changed or the
 * wrong secret; `deviceFlow` with the public app; `revoke` of the refresh token ends the grant (the
 * socket closes 4008). Reports ids and outcomes only: never a token, code, verifier or secret.
 */
import {
  OAUTH_PATHS,
  PKCE_VERIFIER,
  type CommonAirClient,
  type EventSubNotification,
  type EventSubSession,
  type Scope,
  authorizeUrl,
  clientCredentials,
  connectEventSub,
  createClient,
  createPkcePair,
  deviceFlow,
  exchangeCode,
  memoryStore,
  refreshingToken,
  revoke,
  subscribe,
  verifyEventSubRequest,
  type StoredTokens,
} from "@commonair/sdk";
import { WEBHOOK_HEADERS } from "@commonair/contracts/events";
import { waitFor } from "../wait.ts";
import type { ReceivedRequest } from "./receiver.ts";
import { type E9App, type E9Run, type E9Step, machineFetch } from "./run.ts";

/** Follows need no scope; chat reads as the streamer (`chat:read`), as in step 5. */
export const STEP6_SCOPES: readonly Scope[] = ["chat:read"];
/** Marks step 6's webhook callback (same receiver, a different URL than step 4's subscription). */
export const STEP6_CALLBACK_QUERY = "sdk";

const SETTLE_MS = 30_000;

/** The receiver's hook URL with step 6's marker, so the subscription is not a duplicate of step 4's. */
export function step6Callback(receiverUrl: string): string {
  const u = new URL(receiverUrl);
  u.searchParams.set("from", STEP6_CALLBACK_QUERY);
  return u.toString();
}

/** A webhook request to step 6's callback for one subscription and message type. */
export function isStep6Hook(r: ReceivedRequest, subscriptionId: string, messageType: string): boolean {
  if (r.method !== "POST" || r.path !== "/hook" || r.query.from !== STEP6_CALLBACK_QUERY) return false;
  if (r.headers[WEBHOOK_HEADERS.messageType] !== messageType) return false;
  try {
    return (JSON.parse(r.body) as { subscription?: { id?: unknown } }).subscription?.id === subscriptionId;
  } catch {
    return false;
  }
}

/** The body with one byte changed (the first `"` after the envelope's opening brace becomes `'`). */
export function tamper(body: string): string {
  const i = body.indexOf('"', 1);
  if (i < 0) return `${body} `;
  return `${body.slice(0, i)}'${body.slice(i + 1)}`;
}

/** The consent page's query, as the web route would read it, mapped onto `developer.oauth.decide`. */
export function decideInputFrom(url: string) {
  const q = new URL(url).searchParams;
  const get = (k: string) => q.get(k) ?? "";
  return {
    clientId: get("client_id"),
    redirectUri: get("redirect_uri"),
    scope: get("scope"),
    state: get("state"),
    codeChallenge: get("code_challenge"),
    codeChallengeMethod: "S256" as const,
  };
}

async function validate(apiUrl: string, token: string) {
  const res = await fetch(new URL(OAUTH_PATHS.validate, apiUrl), { headers: { authorization: `Bearer ${token}` } });
  const body = res.ok ? ((await res.json()) as { user_id: string | null; scopes: string[] }) : null;
  return { status: res.status, body };
}

const secretOf = () => `whs_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")}`;

async function subscriptionStatus(client: CommonAirClient, id: string): Promise<string | null> {
  let cursor: string | undefined;
  for (;;) {
    const page = await client.developer.events.list({ type: "channel.follow", limit: 100, cursor });
    const hit = page.items.find((s) => s.id === id);
    if (hit) return hit.status;
    if (!page.nextCursor) return null;
    cursor = page.nextCursor;
  }
}

/** PKCE through the SDK; the streamer's session approves as the consent page would. */
async function authorize(r: E9Run, app: E9App): Promise<StoredTokens> {
  const { ctx, env } = r;
  const streamer = r.actors.streamer.user;
  const pkce = await createPkcePair();
  ctx.assert(
    "6. createPkcePair: an RFC 7636 verifier",
    PKCE_VERIFIER.test(pkce.verifier) && pkce.verifier.length === 64,
  );
  const state = crypto.randomUUID();
  const url = authorizeUrl({
    baseUrl: env.HARNESS_WEB_URL,
    clientId: app.clientId,
    redirectUri: app.redirectUri,
    scopes: STEP6_SCOPES,
    state,
    codeChallenge: pkce.challenge,
  });
  ctx.assert("6. authorizeUrl targets the consent page", new URL(url).pathname === OAUTH_PATHS.authorizePage);
  const { redirectTo } = await streamer.api.client.developer.oauth.decide({ ...decideInputFrom(url), approve: true });
  const back = new URL(redirectTo);
  ctx.assert("6. state round-trips", back.searchParams.get("state") === state);
  const code = back.searchParams.get("code");
  if (!code) throw new Error(`step 6: no code on the redirect (error=${back.searchParams.get("error")})`);
  const t = await exchangeCode({
    baseUrl: env.HARNESS_API_URL,
    fetch: machineFetch(r.platform),
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    code,
    redirectUri: app.redirectUri,
    codeVerifier: pkce.verifier,
  });
  ctx.assert(
    "6. exchangeCode: a rotating pair with the scopes",
    t.refreshToken !== null && STEP6_SCOPES.every((s) => t.scopes.includes(s)),
    {
      scopes: t.scopes,
    },
  );
  return { accessToken: t.accessToken, refreshToken: t.refreshToken ?? "", expiresAt: t.expiresAt, scopes: t.scopes };
}

async function run(r: E9Run): Promise<void> {
  const { ctx, env, state, actors } = r;
  const conf = state.confidentialApp;
  const pub = state.publicApp;
  if (!conf?.clientSecret || !pub) throw new Error("step 6 needs step 1's apps");
  const baseUrl = env.HARNESS_API_URL;
  const streamerId = actors.streamer.user.id;
  const viewer = actors.viewer;
  const opts = { timeoutMs: SETTLE_MS, intervalMs: 250, signal: ctx.signal };
  let session: EventSubSession | null = null;
  let webhook: { client: CommonAirClient; id: string } | null = null;

  try {
    const initial = await ctx.step("PKCE through createPkcePair, authorizeUrl and exchangeCode", () =>
      authorize(r, conf),
    );

    const hook = await ctx.step(
      "clientCredentials: a webhook subscription; verifyEventSubRequest accepts the challenge",
      async () => {
        const app = await clientCredentials({
          baseUrl,
          fetch: machineFetch(r.platform),
          clientId: conf.clientId,
          clientSecret: conf.clientSecret ?? "",
        });
        ctx.assert("app token: no refresh token, no scopes", app.refreshToken === null && app.scopes.length === 0);
        const client = createClient({ baseUrl, token: app.accessToken });
        const secret = secretOf();
        const sub = await client.developer.events.subscribe({
          type: "channel.follow",
          version: "1",
          condition: { broadcaster_user_id: streamerId },
          transport: { method: "webhook", callback: step6Callback(state.receiver.url), secret },
        });
        webhook = { client, id: sub.id };
        const challenge = await state.receiver.waitFor(
          (q) => isStep6Hook(q, sub.id, "webhook_callback_verification"),
          SETTLE_MS,
        );
        const v = await verifyEventSubRequest({ secret, headers: challenge.headers, rawBody: challenge.body });
        ctx.assert(
          "the real challenge verifies",
          v.ok && v.messageType === "webhook_callback_verification" && typeof v.challenge === "string",
          {
            reason: v.ok ? null : v.reason,
          },
        );
        await waitFor(
          "step 6 webhook enabled",
          async () => (await subscriptionStatus(client, sub.id)) === "enabled" || null,
          opts,
        );
        return { id: sub.id, secret };
      },
    );

    const saved: StoredTokens[] = [];
    const getToken = refreshingToken({
      baseUrl,
      fetch: machineFetch(r.platform),
      clientId: conf.clientId,
      clientSecret: conf.clientSecret,
      store: memoryStore(initial, (t) => saved.push(t)),
    });
    const client = createClient({ baseUrl, getToken });
    const notes: EventSubNotification[] = [];

    const bound = await ctx.step("connectEventSub: welcome; subscribe channel.follow on the session", async () => {
      const s = await connectEventSub({ baseUrl, onError: (e) => r.log.warn("sdk eventsub", { error: e.message }) });
      session = s;
      s.onNotification((n) => notes.push(n));
      const sub = await subscribe(client, {
        type: "channel.follow",
        condition: { broadcaster_user_id: streamerId },
        sessionId: s.sessionId,
      });
      ctx.assert("enabled on the session", sub.status === "enabled" && sub.transport.method === "websocket", {
        id: sub.id,
      });
      return s;
    });

    await ctx.step(
      "refreshingToken: one forced rotation; the session stays bound and takes the new token",
      async () => {
        const before = await getToken();
        const after = await getToken.refresh();
        ctx.assert("rotated and saved once", after !== before && saved.length === 1 && saved[0]?.accessToken === after);
        ctx.check("the old access token stops validating", (await validate(baseUrl, before)).status === 401);
        const now = await validate(baseUrl, after);
        ctx.assert("the new one validates as the streamer", now.status === 200 && now.body?.user_id === streamerId, {
          status: now.status,
        });
        const chat = await subscribe(client, {
          type: "channel.chat.message",
          condition: { broadcaster_user_id: streamerId, user_id: streamerId },
          sessionId: bound.sessionId,
        });
        ctx.assert("the rotated token subscribes on the same session", chat.status === "enabled", { id: chat.id });
      },
    );

    await ctx.step("the viewer follows: one WebSocket notification and a webhook delivery that verifies", async () => {
      await viewer.api.client.channels.unfollow({ channel: actors.streamer.channel }).catch(() => undefined);
      await viewer.api.client.channels.follow({ channel: actors.streamer.channel, notify: false });
      const ours = (n: EventSubNotification) =>
        n.subscriptionType === "channel.follow" && n.event.user_id === viewer.id;
      await waitFor("the follow over the SDK's EventSub client", () => notes.some(ours) || null, opts);
      const delivery = await state.receiver.waitFor(
        (q) => isStep6Hook(q, hook.id, "notification") && q.body.includes(viewer.id),
        SETTLE_MS,
      );
      const ok = await verifyEventSubRequest({
        secret: hook.secret,
        headers: delivery.headers,
        rawBody: delivery.body,
      });
      ctx.assert("verifyEventSubRequest accepts the real delivery", ok.ok && ok.event?.user_id === viewer.id, {
        reason: ok.ok ? null : ok.reason,
      });
      const tampered = await verifyEventSubRequest({
        secret: hook.secret,
        headers: delivery.headers,
        rawBody: tamper(delivery.body),
      });
      ctx.assert("one byte changed: bad_signature", !tampered.ok && tampered.reason === "bad_signature");
      const wrong = await verifyEventSubRequest({
        secret: secretOf(),
        headers: delivery.headers,
        rawBody: delivery.body,
      });
      ctx.assert("the wrong secret: bad_signature", !wrong.ok && wrong.reason === "bad_signature");
      ctx.assert(
        "exactly one WebSocket notification for the follow",
        notes.filter(ours).length === 1,
        notes.filter(ours).length,
      );
    });

    await ctx.step("deviceFlow with the public app", async () => {
      const t = await deviceFlow({
        baseUrl,
        fetch: machineFetch(r.platform),
        clientId: pub.clientId,
        clientSecret: pub.clientSecret,
        scopes: ["chat:read"],
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(60_000)]),
        onCode: async (c) => {
          const lookup = await actors.streamer.user.api.client.developer.oauth.activation({ userCode: c.userCode });
          ctx.assert("the user code names the public app", lookup.app.clientId === pub.clientId);
          await actors.streamer.user.api.client.developer.oauth.activate({ userCode: c.userCode, approve: true });
        },
      });
      const v = await validate(baseUrl, t.accessToken);
      ctx.assert("device token validates as the streamer", v.status === 200 && v.body?.user_id === streamerId, {
        status: v.status,
      });
    });

    await ctx.step("revoke the refresh token: the grant ends and the session closes 4008", async () => {
      const current = saved.at(-1);
      if (!current) throw new Error("no rotated pair");
      await revoke({
        baseUrl,
        fetch: machineFetch(r.platform),
        clientId: conf.clientId,
        clientSecret: conf.clientSecret,
        token: current.refreshToken,
        tokenTypeHint: "refresh_token",
      });
      ctx.assert("the access token is dead", (await validate(baseUrl, current.accessToken)).status === 401);
      const closed = await Promise.race([bound.closed, Bun.sleep(SETTLE_MS).then(() => null)]);
      ctx.check(
        "the EventSub client reports 4008 as re-authorize",
        closed?.code === 4008 && closed.reauthorize,
        closed ?? { code: 0 },
      );
      ctx.data("sdk", { sessionId: bound.sessionId, webhookSubscriptionId: hook.id, rotations: saved.length });
    });
  } finally {
    (session as EventSubSession | null)?.close();
    const w = webhook as { client: CommonAirClient; id: string } | null;
    if (w) await w.client.developer.events.unsubscribe({ id: w.id }).catch(() => undefined);
  }
}

export const step: E9Step = {
  name: "sdk",
  owner: "E9-sdk",
  ready: true,
  needs: [4, 5],
  run,
};
