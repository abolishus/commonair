// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Step 4 (N1-push; docs/testing/n1-selectors.md "Scenarios"): encrypted web push to the harness
 * receiver over the API. The harness makes a subscription as a browser would, registers it with
 * `notifications.push.subscribe`, turns go-live push on and follows the third streamer; that
 * streamer goes live; the receiver gets one POST whose VAPID JWT verifies against
 * `push.status().vapidPublicKey` and whose body decrypts to the go-live payload. The receiver
 * answers it 410, so the subscription is deleted (`subscriptions` back to 0).
 */
import { waitLive } from "../e8/kit.ts";
import { waitFor } from "../wait.ts";
import { decryptPushBody, newHarnessSubscription, verifyVapidAuthorization } from "./ece.ts";
import type { PushRequest } from "./push-receiver.ts";
import type { N1Run, N1Step } from "./run.ts";

/** Fan-out runs on the outbox relay's next pass, then the push job; generous for a loaded CI runner. */
const PUSH_ARRIVAL_MS = 90_000;
/** The 410 is applied in the same job run that received it. */
const EXPIRY_MS = 30_000;

/** RFC 8030/8291 headers a push service needs; the problems, or an empty list. Pure. */
export function pushHeaderProblems(headers: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  if (headers["content-encoding"] !== "aes128gcm")
    problems.push(`Content-Encoding is ${headers["content-encoding"] ?? "absent"}, not aes128gcm`);
  const ttl = headers.ttl;
  if (ttl === undefined || !/^\d+$/.test(ttl) || Number(ttl) <= 0) problems.push(`TTL is ${ttl ?? "absent"}`);
  if (!/^vapid /i.test(headers.authorization ?? "")) problems.push("Authorization is not a vapid header");
  const urgency = headers.urgency;
  if (urgency !== undefined && !["very-low", "low", "normal", "high"].includes(urgency))
    problems.push(`Urgency is ${urgency}`);
  const topic = headers.topic;
  if (topic !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(topic)) problems.push(`Topic ${topic} is not RFC 8030`);
  return problems;
}

export interface GoLivePush {
  v: 1;
  type: "go_live";
  slug: string;
  title: string;
}

/** The decrypted plaintext as the contract's `PushPayload`, with nothing else in it. Pure. */
export function parseGoLivePush(plaintext: Uint8Array): GoLivePush {
  const value: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("push payload is not an object");
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "slug,title,type,v")
    throw new Error(`push payload carries ${keys}; expected exactly v, type, slug, title`);
  if (o.v !== 1 || o.type !== "go_live") throw new Error(`push payload is v=${String(o.v)} type=${String(o.type)}`);
  if (typeof o.slug !== "string" || typeof o.title !== "string" || o.title.length > 140)
    throw new Error("push payload slug/title malformed");
  return { v: 1, type: "go_live", slug: o.slug, title: o.title };
}

export async function runPushStep(run: N1Run): Promise<void> {
  const { ctx, receiver, actors } = run;
  const viewer = actors.viewer;
  const streamer = actors.streamers[2];
  const api = viewer.api.client;
  run.state.pushChannel = streamer.channel;

  const status = await ctx.step("push: status offers push with a VAPID key", async () => {
    const s = await api.notifications.push.status();
    if (!s.enabled || s.vapidPublicKey === null)
      throw new Error("notifications.push.status says push is off (WEB_PUSH_ENABLED; harness/compose.n1.yaml)");
    return { vapidPublicKey: s.vapidPublicKey, before: s.subscriptions };
  });

  const id = `api-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const endpoint = receiver.endpoint(id);
  const sub = await ctx.step("push: register a harness-made subscription", async () => {
    const made = await newHarnessSubscription(endpoint);
    await api.notifications.push.subscribe({ endpoint: made.endpoint, keys: made.keys });
    const after = await api.notifications.push.status();
    if (after.subscriptions !== status.before + 1)
      throw new Error(`subscriptions went ${status.before} → ${after.subscriptions}, expected one more`);
    return made;
  });
  run.state.apiSubscription = sub;

  await ctx.step("push: go-live push on, follow the third streamer (bell on)", async () => {
    await api.notifications.preferences.set({ type: "go_live", medium: "push", channel: null, enabled: true });
    await api.channels.follow({ channel: streamer.channel, notify: true });
  });

  // Answer the go-live 410: the receiver still records it, and the sender must delete the row.
  receiver.setStatus(id, 410);
  await ctx.step(`push: ${streamer.channel} goes live`, async () => {
    const s = await ctx.platform.streamerFor(streamer.user, {
      protocol: "rtmp",
      width: 640,
      height: 360,
      bitrateKbps: 800,
    });
    ctx.defer(() => s.stop());
    await s.start();
    await waitLive(ctx, streamer.channel);
  });

  const req: PushRequest = await ctx.step("push: the receiver gets the encrypted POST", () =>
    receiver.waitFor((r) => r.id === id, PUSH_ARRIVAL_MS),
  );

  await ctx.step("push: RFC 8030 headers and a VAPID JWT that verifies", async () => {
    const problems = pushHeaderProblems(req.headers);
    if (problems.length > 0) throw new Error(problems.join("; "));
    const claims = await verifyVapidAuthorization(
      req.headers.authorization ?? "",
      endpoint,
      status.vapidPublicKey,
      Date.now(),
    );
    if (claims.aud !== receiver.origin) throw new Error(`VAPID aud ${claims.aud} is not ${receiver.origin}`);
    if (!claims.sub.startsWith("mailto:")) throw new Error("VAPID sub is not a mailto: URI");
    ctx.data("push.headers", { ttl: req.headers.ttl, urgency: req.headers.urgency, topic: req.headers.topic });
  });

  await ctx.step("push: the body decrypts to the go-live payload", async () => {
    const payload = parseGoLivePush(await decryptPushBody(req.body, sub));
    if (payload.slug !== streamer.channel)
      throw new Error(`payload slug ${payload.slug}, expected ${streamer.channel}`);
    ctx.data("push.payload", { slug: payload.slug, titleLength: payload.title.length });
  });

  await ctx.step("push: the 410 deletes the subscription", async () => {
    await waitFor(
      "push.status().subscriptions back to the count before",
      async () => (await api.notifications.push.status()).subscriptions === status.before,
      { timeoutMs: EXPIRY_MS, intervalMs: 500, signal: ctx.signal },
    );
    const sent = receiver.requests.filter((r) => r.id === id).length;
    if (sent !== 1) throw new Error(`the receiver got ${sent} POSTs for one go-live, expected 1`);
  });
}

export const step: N1Step = {
  name: "push over the API",
  owner: "N1-push",
  needs: [],
  requires: ["webPush"],
  run: runPushStep,
};
