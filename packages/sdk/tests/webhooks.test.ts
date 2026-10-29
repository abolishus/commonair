// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

import { WEBHOOK_HEADERS, signWebhook } from "@commonair/contracts/events";
import { describe, expect, test } from "vite-plus/test";
import { createDedupe, verifyEventSubRequest, verifyEventSubWebRequest } from "../src/index.ts";

const SECRET = "whs_test_secret_123";
const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const subscription = {
  id: "0193a1b2-0000-7000-8000-0000000000aa",
  type: "channel.follow",
  version: "1",
  status: "enabled",
  condition: { broadcaster_user_id: "0193a1b2-0000-7000-8000-000000000001" },
  transport: { method: "webhook", callback: "https://bot.example.test/hook" },
  created_at: "2026-10-29T11:00:00.000Z",
};

async function delivery(opts: {
  type?: string;
  body?: Record<string, unknown>;
  timestamp?: string;
  secret?: string;
  id?: string;
  retry?: string;
}) {
  const rawBody = JSON.stringify(opts.body ?? { subscription, event: { user_id: "u1", user_login: "viewer" } });
  const timestamp = opts.timestamp ?? new Date(NOW - 5_000).toISOString();
  const id = opts.id ?? "msg-1";
  const headers: Record<string, string> = {
    [WEBHOOK_HEADERS.messageId]: id,
    [WEBHOOK_HEADERS.messageRetry]: opts.retry ?? "0",
    [WEBHOOK_HEADERS.messageType]: opts.type ?? "notification",
    [WEBHOOK_HEADERS.messageSignature]: await signWebhook(opts.secret ?? SECRET, id, timestamp, rawBody),
    [WEBHOOK_HEADERS.messageTimestamp]: timestamp,
    [WEBHOOK_HEADERS.subscriptionType]: "channel.follow",
    [WEBHOOK_HEADERS.subscriptionVersion]: "1",
  };
  return { rawBody, headers };
}

describe("verifyEventSubRequest", () => {
  test("a valid notification verifies and exposes the event", async () => {
    const d = await delivery({ retry: "2" });
    const r = await verifyEventSubRequest({ secret: SECRET, ...d, now: NOW });
    expect(r).toMatchObject({ ok: true, messageType: "notification", messageId: "msg-1", retry: 2 });
    if (!r.ok) throw new Error("unreachable");
    expect(r.subscription.id).toBe(subscription.id);
    expect(r.event).toEqual({ user_id: "u1", user_login: "viewer" });
    expect(r.challenge).toBeUndefined();
  });

  test("a tampered body (one byte) is bad_signature", async () => {
    const d = await delivery({});
    const rawBody = d.rawBody.replace("viewer", "viewes");
    expect(await verifyEventSubRequest({ secret: SECRET, headers: d.headers, rawBody, now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  test("a stale or future timestamp is refused before the signature is checked", async () => {
    for (const offset of [10 * 60_000 + 1, -(10 * 60_000 + 1)]) {
      const d = await delivery({ timestamp: new Date(NOW - offset).toISOString() });
      expect(await verifyEventSubRequest({ secret: SECRET, ...d, now: NOW })).toEqual({
        ok: false,
        reason: "stale_timestamp",
      });
    }
    const edge = await delivery({ timestamp: new Date(NOW - 10 * 60_000).toISOString() });
    expect((await verifyEventSubRequest({ secret: SECRET, ...edge, now: NOW })).ok).toBe(true);
    const garbage = await delivery({ timestamp: "yesterday" });
    expect(await verifyEventSubRequest({ secret: SECRET, ...garbage, now: NOW })).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  test("the wrong secret is bad_signature", async () => {
    const d = await delivery({ secret: "someone_elses_secret" });
    expect(await verifyEventSubRequest({ secret: SECRET, ...d, now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  test("a callback verification carries the challenge", async () => {
    const d = await delivery({
      type: "webhook_callback_verification",
      body: {
        subscription: { ...subscription, status: "webhook_callback_verification_pending" },
        challenge: "pogchamp-kappa",
      },
    });
    const r = await verifyEventSubRequest({ secret: SECRET, ...d, now: NOW });
    expect(r).toMatchObject({ ok: true, messageType: "webhook_callback_verification", challenge: "pogchamp-kappa" });
    const noChallenge = await delivery({ type: "webhook_callback_verification", body: { subscription } });
    expect(await verifyEventSubRequest({ secret: SECRET, ...noChallenge, now: NOW })).toEqual({
      ok: false,
      reason: "invalid_body",
    });
  });

  test("a revocation verifies without an event", async () => {
    const d = await delivery({
      type: "revocation",
      body: { subscription: { ...subscription, status: "authorization_revoked" } },
    });
    const r = await verifyEventSubRequest({ secret: SECRET, ...d, now: NOW });
    expect(r).toMatchObject({ ok: true, messageType: "revocation" });
    expect(r.ok && r.subscription.status).toBe("authorization_revoked");
  });

  test("missing headers, an unknown message type and a signed non-envelope body are refused", async () => {
    const d = await delivery({});
    const { [WEBHOOK_HEADERS.messageSignature]: _sig, ...noSig } = d.headers;
    expect(await verifyEventSubRequest({ secret: SECRET, headers: noSig, rawBody: d.rawBody, now: NOW })).toEqual({
      ok: false,
      reason: "missing_headers",
    });
    const odd = await delivery({ type: "mystery" });
    expect(await verifyEventSubRequest({ secret: SECRET, ...odd, now: NOW })).toEqual({
      ok: false,
      reason: "unknown_message_type",
    });
    const notEnvelope = await delivery({ body: { hello: "world" } });
    expect(await verifyEventSubRequest({ secret: SECRET, ...notEnvelope, now: NOW })).toEqual({
      ok: false,
      reason: "invalid_body",
    });
  });

  test("an event type this SDK does not know yet still verifies", async () => {
    const d = await delivery({ body: { subscription: { ...subscription, type: "channel.future.thing" }, event: {} } });
    const r = await verifyEventSubRequest({ secret: SECRET, ...d, now: NOW });
    expect(r.ok && r.subscription.type).toBe("channel.future.thing");
  });

  test("headers as a Headers object, mixed-case records and Node's string[] values", async () => {
    const d = await delivery({});
    expect(
      (await verifyEventSubRequest({ secret: SECRET, headers: new Headers(d.headers), rawBody: d.rawBody, now: NOW }))
        .ok,
    ).toBe(true);
    const upper = Object.fromEntries(Object.entries(d.headers).map(([k, v]) => [k.toUpperCase(), [v]]));
    expect((await verifyEventSubRequest({ secret: SECRET, headers: upper, rawBody: d.rawBody, now: NOW })).ok).toBe(
      true,
    );
  });

  test("verifyEventSubWebRequest reads a Request without consuming it", async () => {
    const d = await delivery({});
    const req = new Request("https://bot.example.test/hook", { method: "POST", headers: d.headers, body: d.rawBody });
    const r = await verifyEventSubWebRequest(req, SECRET, { now: NOW });
    expect(r.ok).toBe(true);
    expect(r.rawBody).toBe(d.rawBody);
    expect(await req.text()).toBe(d.rawBody);
  });
});

describe("createDedupe", () => {
  test("first sighting true, repeats false, oldest forgotten past the window", () => {
    const d = createDedupe(3);
    expect(["a", "b", "a", "c"].map((id) => d.firstSeen(id))).toEqual([true, true, false, true]);
    expect(d.size).toBe(3);
    expect(d.firstSeen("d")).toBe(true);
    expect(d.has("a")).toBe(false);
    expect(d.has("d")).toBe(true);
    expect(d.firstSeen("a")).toBe(true);
    expect(() => createDedupe(0)).toThrow(RangeError);
  });
});
