// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure helpers of `developer-platform` step 4 (harness/src/e9/webhook.ts). */
import { describe, expect, test } from "vite-plus/test";
import { WEBHOOK_HEADERS, signWebhook } from "@commonair/contracts/events";
import type { ReceivedRequest } from "../../src/e9/receiver.ts";
import { isMessage, newWebhookSecret, refusal, signatureValid, step, webhookBody } from "../../src/e9/webhook.ts";

const SUB = "01900000-0000-7000-8000-000000000001";

function request(over: Partial<ReceivedRequest> & { type?: string; json?: unknown } = {}): ReceivedRequest {
  const { type = "notification", json = { subscription: { id: SUB }, event: { user_id: "v" } }, ...rest } = over;
  return {
    method: "POST",
    path: "/hook",
    query: {},
    headers: { [WEBHOOK_HEADERS.messageType]: type },
    body: JSON.stringify(json),
    receivedAt: 0,
    ...rest,
  };
}

async function signed(secret: string, body: string, timestamp = new Date().toISOString()): Promise<ReceivedRequest> {
  const id = "msg-1";
  return request({
    body,
    headers: {
      [WEBHOOK_HEADERS.messageType]: "notification",
      [WEBHOOK_HEADERS.messageId]: id,
      [WEBHOOK_HEADERS.messageTimestamp]: timestamp,
      [WEBHOOK_HEADERS.messageSignature]: await signWebhook(secret, id, timestamp, body),
    },
  });
}

describe("webhookBody / isMessage", () => {
  test("matches the subscription, message type, method and path", () => {
    expect(isMessage(request(), SUB, "notification")).toBe(true);
    expect(isMessage(request(), SUB, "revocation")).toBe(false);
    expect(isMessage(request(), "other", "notification")).toBe(false);
    expect(isMessage(request({ path: "/cb" }), SUB, "notification")).toBe(false);
    expect(isMessage(request({ method: "GET" }), SUB, "notification")).toBe(false);
  });
  test("non-JSON and subscription-less bodies are not webhooks", () => {
    expect(webhookBody({ body: "nope" })).toBeNull();
    expect(webhookBody({ body: "[]" })).toBeNull();
    expect(webhookBody({ body: JSON.stringify({ event: {} }) })).toBeNull();
    expect(webhookBody(request())?.event?.user_id).toBe("v");
  });
});

describe("signatureValid", () => {
  test("verifies the receiver's raw bytes; a tampered body or wrong secret fails", async () => {
    const secret = newWebhookSecret();
    const r = await signed(secret, JSON.stringify({ subscription: { id: SUB } }));
    expect(await signatureValid(secret, r)).toBe(true);
    expect(await signatureValid("another-secret-xyz", r)).toBe(false);
    expect(await signatureValid(secret, { ...r, body: `${r.body} ` })).toBe(false);
  });
  test("stale messages fail", async () => {
    const secret = newWebhookSecret();
    const r = await signed(secret, "{}", new Date(Date.now() - 11 * 60_000).toISOString());
    expect(await signatureValid(secret, r)).toBe(false);
  });
});

describe("refusal", () => {
  test("code and requirement of an oRPC error", () => {
    expect(refusal({ code: "PRECONDITION_FAILED", data: { requirement: "websocket_only" } })).toEqual({
      code: "PRECONDITION_FAILED",
      requirement: "websocket_only",
    });
    expect(refusal({ code: "FORBIDDEN" })).toEqual({ code: "FORBIDDEN", requirement: null });
    expect(refusal(null)).toEqual({ code: null, requirement: null });
    expect(refusal("boom")).toEqual({ code: null, requirement: null });
  });
});

describe("step", () => {
  test("ready, owned by E9-subs, needs step 2's app token", () => {
    expect(step).toMatchObject({ name: "webhook", owner: "E9-subs", ready: true, needs: [2] });
  });
  test("secrets fit the subscribe input (10-100 characters) and differ", () => {
    const a = newWebhookSecret();
    expect(a.length).toBeGreaterThanOrEqual(10);
    expect(a.length).toBeLessThanOrEqual(100);
    expect(newWebhookSecret()).not.toBe(a);
  });
});
