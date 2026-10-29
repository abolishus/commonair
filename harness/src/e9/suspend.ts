// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer-platform` step 8 (E9-apps; docs/testing/e9-selectors.md "Scenarios"), over the API:
 * the streamer re-authorizes the confidential app (step 5 revoked the grant) and binds an EventSub
 * WebSocket session with it. The admin suspends the app (`abuse`): its tokens fail
 * `oauth2/validate`, step 4's webhook subscription is `revoked` and the receiver gets one
 * `revocation` for it, the socket closes 4008, and `safety.auditLog` (subject `oauth_app`) has
 * `developer.app.suspend` with the reason. Unsuspending leaves the tokens revoked; the owner
 * deletes the app and its subscriptions are gone. Ids and outcomes only in the report.
 */
import { EVENTSUB_WS_CLOSE, EVENTSUB_WS_PATH } from "@commonair/contracts/eventsub";
import { WEBHOOK_HEADERS } from "@commonair/contracts/events";
import type { Scope } from "@commonair/contracts/scopes";
import { apiError } from "../safety.ts";
import { sleep, withTimeout } from "../wait.ts";
import type { ReceivedRequest } from "./receiver.ts";
import { authorizeOverApi, type E9Run, type E9Step } from "./run.ts";
import { openEventSub } from "./ws-client.ts";

/** Step 2's scopes: the grant the streamer had before step 5 revoked it. */
export const REAUTHORIZE_SCOPES: readonly Scope[] = [
  "chat:read",
  "channel:read:subscriptions",
  "channel:manage:polls",
  "channel:read:points",
];
export const SUSPEND_REASON = "abuse" as const;
const CLOSE_WAIT_MS = 30_000;
/** After the first revocation arrives, how long to watch for a duplicate. */
const DUPLICATE_WATCH_MS = 3_000;

/** `ws(s)://<api>/eventsub/ws` from the API's http(s) base URL. */
export function eventSubUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, "").replace(/^http/, "ws")}${EVENTSUB_WS_PATH}`;
}

/** A webhook `revocation` message for this subscription, as the receiver recorded it. */
export function isRevocationFor(
  r: Pick<ReceivedRequest, "method" | "path" | "headers" | "body">,
  subscriptionId: string,
) {
  if (r.method !== "POST" || r.path !== "/hook") return false;
  if (r.headers[WEBHOOK_HEADERS.messageType] !== "revocation") return false;
  try {
    const body = JSON.parse(r.body) as { subscription?: { id?: unknown } };
    return body.subscription?.id === subscriptionId;
  } catch {
    return false;
  }
}

/** The API refused the call with this oRPC code (a resolved call is no refusal). */
async function refusal(p: Promise<unknown>): Promise<string | null> {
  return p.then(
    () => null,
    (e: unknown) => apiError(e).code ?? "unknown",
  );
}

async function runStep(run: E9Run): Promise<void> {
  const { ctx, state, platform } = run;
  const { streamer, admin, developer } = run.actors;
  const app = state.confidentialApp;
  const followSubscriptionId = state.followSubscriptionId;
  if (!app) throw new Error("step 8 needs step 1's confidential app");
  if (!followSubscriptionId) throw new Error("step 8 needs step 4's webhook subscription");

  const grant = await ctx.step("streamer re-authorizes the confidential app", () =>
    authorizeOverApi(run, { app, actor: streamer.user, scopes: REAUTHORIZE_SCOPES }),
  );
  const asGrant = platform.api({ bearer: grant.accessToken }).client;

  const socket = await ctx.step("a WebSocket session bound with the new grant", async () => {
    const conn = await openEventSub(eventSubUrl(run.env.HARNESS_API_URL));
    ctx.defer(() => conn.close());
    const welcome = await conn.next("session_welcome");
    const sessionId = welcome.payload.session?.id;
    if (!sessionId) throw new Error("session_welcome carried no session id");
    const sub = await asGrant.developer.events.subscribe({
      type: "channel.follow",
      version: "1",
      condition: { broadcaster_user_id: streamer.user.id },
      transport: { method: "websocket", sessionId },
    });
    ctx.assert("websocket subscription enabled", sub.status === "enabled", { id: sub.id, status: sub.status });
    return conn;
  });

  const suspended = await ctx.step(`admin suspends the app (${SUSPEND_REASON})`, async () => {
    const r = await admin.api.client.developer.admin.suspend({ id: app.id, reason: SUSPEND_REASON });
    ctx.assert("suspended with the reason", r.suspended?.reason === SUSPEND_REASON, {
      id: r.id,
      suspended: r.suspended,
    });
    ctx.assert("no live grants or enabled webhooks remain", r.grants === 0 && r.subscriptions === 0, {
      grants: r.grants,
      subscriptions: r.subscriptions,
    });
    return r;
  });
  ctx.data("suspended", { appId: suspended.id, at: suspended.suspended?.at ?? null });

  await ctx.step("the app's tokens fail oauth2/validate", async () => {
    const code = await refusal(asGrant.developer.tokens.validate());
    ctx.assert("the grant's access token is refused", code === "UNAUTHORIZED", { code });
    if (state.appToken) {
      const appCode = await refusal(platform.api({ bearer: state.appToken }).client.developer.tokens.validate());
      ctx.assert("the app token is refused", appCode === "UNAUTHORIZED", { code: appCode });
    }
  });

  await ctx.step("step 4's webhook subscription is revoked and the receiver got one revocation", async () => {
    const page = await developer.api.client.developer.events.list({ appId: app.id, limit: 100 });
    const sub = page.items.find((s) => s.id === followSubscriptionId);
    ctx.assert("subscription revoked", sub?.status === "revoked", { id: followSubscriptionId, status: sub?.status });
    await state.receiver.waitFor((r) => isRevocationFor(r, followSubscriptionId));
    // A retried job must not notify twice.
    await sleep(DUPLICATE_WATCH_MS, ctx.signal);
    const n = state.receiver.requests.filter((r) => isRevocationFor(r, followSubscriptionId)).length;
    ctx.assert("exactly one revocation", n === 1, { revocations: n });
  });

  await ctx.step("the bound socket closes 4008", async () => {
    const closed = await withTimeout("eventsub socket close", socket.closed, CLOSE_WAIT_MS);
    ctx.assert("closed with authorizationRevoked", closed.code === EVENTSUB_WS_CLOSE.authorizationRevoked, closed);
  });

  await ctx.step("the audit log has developer.app.suspend with the reason", async () => {
    const log = await admin.api.client.safety.auditLog({ subjectType: "oauth_app", subjectId: app.id, limit: 25 });
    const row = log.items.find((e) => e.action === "developer.app.suspend");
    ctx.assert("audit row present", row !== undefined, { actions: log.items.map((e) => e.action) });
    ctx.assert("reason code only", row?.details.reason === SUSPEND_REASON && row.reason === "", row?.details);
    ctx.assert("by the admin", row?.actorId === admin.id, { actorId: row?.actorId ?? null });
  });

  await ctx.step("unsuspend leaves the tokens revoked", async () => {
    const r = await admin.api.client.developer.admin.unsuspend({ id: app.id });
    ctx.assert("no longer suspended", r.suspended === null, { id: r.id });
    const code = await refusal(asGrant.developer.tokens.validate());
    ctx.assert("the grant's token is still refused", code === "UNAUTHORIZED", { code });
  });

  await ctx.step("the owner deletes the app and its subscriptions are gone", async () => {
    await developer.api.client.developer.apps.remove({ id: app.id });
    const apps = await developer.api.client.developer.apps.list();
    ctx.assert("app gone from the list", !apps.some((a) => a.id === app.id));
    // Session callers see the subscriptions of apps they own; the app is gone, so none are left.
    const left = await developer.api.client.developer.events.list({ appId: app.id, limit: 100 }).then(
      (p) => p.items.length,
      (e: unknown) => (apiError(e).code === "NOT_FOUND" ? 0 : Promise.reject(e)),
    );
    ctx.assert("developer.events.list is empty for it", left === 0, { left });
  });
  delete state.confidentialApp;
  delete state.followSubscriptionId;
}

export const step: E9Step = {
  name: "suspend",
  owner: "E9-apps",
  ready: true,
  needs: [4, 5],
  run: runStep,
};
