// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer-platform` step 4 (E9-subs): with step 2's app token, a webhook subscription to
 * `channel.follow` for the streamer; the receiver answers the challenge and the subscription turns
 * `enabled`; the viewer follows and exactly one signed notification arrives and is logged in
 * `developer.events.deliveries`; `sendTest` arrives; `redeliver` re-sends the same message id.
 * Refused: `channel.chat.message` by webhook (WebSocket only), and a `channel.subscribe` webhook
 * for a broadcaster who never authorized the app. The subscription stays for steps 7 and 8.
 */
import { WEBHOOK_HEADERS, verifyWebhook } from "@commonair/contracts/events";
import type { ApiClient } from "../api/client.ts";
import { waitFor } from "../wait.ts";
import type { ReceivedRequest } from "./receiver.ts";
import type { E9Run, E9Step } from "./run.ts";

const SETTLE_MS = 30_000;

/** The parsed body of a received webhook, or null when it is not JSON with a subscription. */
export function webhookBody(r: Pick<ReceivedRequest, "body">): {
  subscription: { id?: unknown; status?: unknown };
  event?: Record<string, unknown>;
  challenge?: unknown;
} | null {
  try {
    const parsed = JSON.parse(r.body) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const sub = (parsed as { subscription?: unknown }).subscription;
    if (typeof sub !== "object" || sub === null) return null;
    return parsed as never;
  } catch {
    return null;
  }
}

/** A POST to the hook of one message type for one subscription. */
export function isMessage(r: ReceivedRequest, subscriptionId: string, messageType: string): boolean {
  if (r.method !== "POST" || r.path !== "/hook") return false;
  if (r.headers[WEBHOOK_HEADERS.messageType] !== messageType) return false;
  return webhookBody(r)?.subscription.id === subscriptionId;
}

/** Does the request carry a valid signature for `secret` (receivers must check before trusting it)? */
export function signatureValid(secret: string, r: ReceivedRequest, now = Date.now()): Promise<boolean> {
  return verifyWebhook(
    secret,
    r.headers[WEBHOOK_HEADERS.messageId] ?? "",
    r.headers[WEBHOOK_HEADERS.messageTimestamp] ?? "",
    r.body,
    r.headers[WEBHOOK_HEADERS.messageSignature] ?? "",
    now,
  );
}

/** `{ code, requirement }` of a refused oRPC call (`requirement` from PRECONDITION_FAILED data). */
export function refusal(err: unknown): { code: string | null; requirement: string | null } {
  if (typeof err !== "object" || err === null) return { code: null, requirement: null };
  const e = err as { code?: unknown; data?: unknown };
  const data = typeof e.data === "object" && e.data !== null ? (e.data as { requirement?: unknown }) : null;
  return {
    code: typeof e.code === "string" ? e.code : null,
    requirement: typeof data?.requirement === "string" ? data.requirement : null,
  };
}

/** A webhook secret (10-100 characters). Never logged or reported. */
export function newWebhookSecret(): string {
  return `whs_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")}`;
}

const settled = <T>(p: Promise<T>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

async function findSubscription(api: ApiClient, id: string) {
  let cursor: string | undefined;
  for (;;) {
    const page = await api.developer.events.list({ type: "channel.follow", limit: 100, cursor });
    const hit = page.items.find((s) => s.id === id);
    if (hit) return hit;
    if (!page.nextCursor) return null;
    cursor = page.nextCursor;
  }
}

async function run(run: E9Run): Promise<void> {
  const { ctx, state } = run;
  const appToken = state.appToken;
  if (!appToken) throw new Error("step 4 needs step 2's app token");
  const receiver = state.receiver;
  const asApp = run.platform.api({ bearer: appToken }).client;
  const streamer = run.actors.streamer;
  const viewer = run.actors.viewer;
  const secret = newWebhookSecret();
  const opts = { timeoutMs: SETTLE_MS, intervalMs: 250, signal: ctx.signal };

  const sub = await ctx.step("the app token subscribes to channel.follow by webhook", async () => {
    const s = await asApp.developer.events.subscribe({
      type: "channel.follow",
      version: "1",
      condition: { broadcaster_user_id: streamer.user.id },
      transport: { method: "webhook", callback: receiver.url, secret },
    });
    ctx.assert("pending verification", s.status === "verification_pending", { status: s.status });
    if (state.confidentialApp)
      ctx.assert("the subscription is the app's", s.appId === state.confidentialApp.id, { appId: s.appId });
    ctx.assert("scope-less: backed by the app's owner", s.userId === run.actors.developer.id, { userId: s.userId });
    return s;
  });
  state.followSubscriptionId = sub.id;

  await ctx.step("the receiver answers the challenge and the subscription is enabled", async () => {
    const challenge = await receiver.waitFor((r) => isMessage(r, sub.id, "webhook_callback_verification"), SETTLE_MS);
    ctx.assert("challenge signed", await signatureValid(secret, challenge));
    await waitFor(
      "subscription enabled",
      async () => (await findSubscription(asApp, sub.id))?.status === "enabled" || null,
      opts,
    );
  });

  const delivery = await ctx.step("the viewer follows: one signed notification, logged", async () => {
    // A follow left over from another run would make this a no-op: start from not following.
    await settled(viewer.api.client.channels.unfollow({ channel: streamer.channel }));
    await viewer.api.client.channels.follow({ channel: streamer.channel, notify: false });
    const isOurs = (r: ReceivedRequest) =>
      isMessage(r, sub.id, "notification") && webhookBody(r)?.event?.user_id === viewer.id;
    const got = await receiver.waitFor(isOurs, SETTLE_MS);
    ctx.assert("signature verifies", await signatureValid(secret, got));
    const messageId = got.headers[WEBHOOK_HEADERS.messageId] ?? "";
    const logged = await waitFor(
      "delivery logged",
      async () => {
        const page = await asApp.developer.events.deliveries({ id: sub.id, limit: 100 });
        return page.items.find((d) => d.messageId === messageId && d.messageType === "notification") ?? null;
      },
      opts,
    );
    ctx.assert("logged as succeeded", logged.status === "succeeded", { status: logged.status });
    ctx.assert(
      "exactly one notification for the follow",
      receiver.requests.filter(isOurs).length === 1,
      receiver.requests.filter(isOurs).length,
    );
    return logged;
  });

  await ctx.step("sendTest arrives", async () => {
    const { eventId } = await asApp.developer.events.sendTest({ id: sub.id });
    const logged = await waitFor(
      "test delivery logged",
      async () =>
        (await asApp.developer.events.deliveries({ id: sub.id, limit: 100 })).items.find(
          (d) => d.eventId === eventId,
        ) ?? null,
      opts,
    );
    const got = await receiver.waitFor(
      (r) => isMessage(r, sub.id, "notification") && r.headers[WEBHOOK_HEADERS.messageId] === logged.messageId,
      SETTLE_MS,
    );
    ctx.assert("test event signed", await signatureValid(secret, got));
  });

  await ctx.step("redeliver re-sends the same message id", async () => {
    const sameId = (r: ReceivedRequest) =>
      isMessage(r, sub.id, "notification") && r.headers[WEBHOOK_HEADERS.messageId] === delivery.messageId;
    await asApp.developer.events.redeliver({ id: delivery.id });
    const again = await waitFor(
      "redelivery received",
      () => (receiver.requests.filter(sameId).length >= 2 ? receiver.requests.filter(sameId)[1] : null),
      opts,
    );
    ctx.assert("redelivery signed", await signatureValid(secret, again));
    ctx.assert("redelivery marked as a retry", again.headers[WEBHOOK_HEADERS.messageRetry] !== "0", {
      retry: again.headers[WEBHOOK_HEADERS.messageRetry],
    });
  });

  await ctx.step("refused: channel.chat.message by webhook", async () => {
    const err = await settled(
      asApp.developer.events.subscribe({
        type: "channel.chat.message",
        version: "1",
        condition: { broadcaster_user_id: streamer.user.id, user_id: streamer.user.id },
        transport: { method: "webhook", callback: receiver.url, secret },
      }),
    );
    const r = refusal(err);
    ctx.assert("websocket_only", r.code === "PRECONDITION_FAILED" && r.requirement === "websocket_only", r);
  });

  await ctx.step("refused: channel.subscribe of a broadcaster who never authorized the app", async () => {
    const err = await settled(
      asApp.developer.events.subscribe({
        type: "channel.subscribe",
        version: "1",
        condition: { broadcaster_user_id: viewer.id },
        transport: { method: "webhook", callback: receiver.url, secret },
      }),
    );
    ctx.assert("FORBIDDEN", refusal(err).code === "FORBIDDEN", refusal(err));
  });
}

export const step: E9Step = {
  name: "webhook",
  owner: "E9-subs",
  ready: true,
  needs: [2],
  run,
};
