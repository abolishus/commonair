// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { WEBHOOK_HEADERS, signWebhook } from "@commonair/contracts/events";
import { authorizeUrl, createPkcePair, verifyEventSubRequest } from "@commonair/sdk";
import { describe, expect, test } from "vite-plus/test";
import type { ReceivedRequest } from "../../src/e9/receiver.ts";
import { decideInputFrom, isStep6Hook, step, step6Callback, tamper } from "../../src/e9/sdk.ts";

const hook = (over: Partial<ReceivedRequest> = {}): ReceivedRequest => ({
  method: "POST",
  path: "/hook",
  query: { from: "sdk" },
  headers: { [WEBHOOK_HEADERS.messageType]: "notification" },
  body: JSON.stringify({ subscription: { id: "sub-1" }, event: { user_id: "v" } }),
  receivedAt: 0,
  ...over,
});

describe("step 6 helpers", () => {
  test("the callback is the receiver's hook with a marker query", () => {
    const u = new URL(step6Callback("http://host.containers.internal:4567/hook"));
    expect(u.pathname).toBe("/hook");
    expect(u.searchParams.get("from")).toBe("sdk");
    expect(u.host).toBe("host.containers.internal:4567");
  });

  test("isStep6Hook matches path, marker, message type and subscription", () => {
    expect(isStep6Hook(hook(), "sub-1", "notification")).toBe(true);
    expect(isStep6Hook(hook({ query: {} }), "sub-1", "notification")).toBe(false);
    expect(isStep6Hook(hook(), "sub-2", "notification")).toBe(false);
    expect(isStep6Hook(hook(), "sub-1", "revocation")).toBe(false);
    expect(isStep6Hook(hook({ method: "GET" }), "sub-1", "notification")).toBe(false);
    expect(isStep6Hook(hook({ body: "not json" }), "sub-1", "notification")).toBe(false);
  });

  test("tamper changes exactly one byte, and the SDK then refuses the signature", async () => {
    const body = hook().body;
    const t = tamper(body);
    expect(t).toHaveLength(body.length);
    let differ = 0;
    for (let i = 0; i < body.length; i++) if (t[i] !== body[i]) differ++;
    expect(differ).toBe(1);
    const ts = new Date().toISOString();
    const headers = {
      [WEBHOOK_HEADERS.messageId]: "m1",
      [WEBHOOK_HEADERS.messageTimestamp]: ts,
      [WEBHOOK_HEADERS.messageType]: "notification",
      [WEBHOOK_HEADERS.messageSignature]: await signWebhook("s".repeat(12), "m1", ts, body),
    };
    // The untouched body passes the signature (then fails only on its stand-in envelope).
    expect(await verifyEventSubRequest({ secret: "s".repeat(12), headers, rawBody: body })).toEqual({
      ok: false,
      reason: "invalid_body",
    });
    expect(await verifyEventSubRequest({ secret: "s".repeat(12), headers, rawBody: t })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  test("decideInputFrom reads back what authorizeUrl wrote", async () => {
    const pkce = await createPkcePair();
    const url = authorizeUrl({
      baseUrl: "http://localhost:3000",
      clientId: "cid",
      redirectUri: "http://127.0.0.1:9/cb",
      scopes: ["chat:read", "chat:edit"],
      state: "st&ate",
      codeChallenge: pkce.challenge,
    });
    expect(decideInputFrom(url)).toEqual({
      clientId: "cid",
      redirectUri: "http://127.0.0.1:9/cb",
      scope: "chat:read chat:edit",
      state: "st&ate",
      codeChallenge: pkce.challenge,
      codeChallengeMethod: "S256",
    });
  });

  test("the step is ready, owned by E9-sdk, and needs steps 4 and 5", () => {
    expect(step).toMatchObject({ name: "sdk", owner: "E9-sdk", ready: true, needs: [4, 5] });
    expect(step.webOnly).toBeUndefined();
  });
});
