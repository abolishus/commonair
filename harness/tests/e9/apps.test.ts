// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `developer-platform` steps 1 and 8 (E9-apps): their pure helpers. */
import { describe, expect, test } from "vite-plus/test";
import { WEBHOOK_HEADERS } from "@commonair/contracts/events";
import { appSummary, clientCredentialsForm, oauthErrorCode, step as appStep } from "../../src/e9/app.ts";
import { eventSubUrl, isRevocationFor, step as suspendStep } from "../../src/e9/suspend.ts";

describe("step 1 helpers", () => {
  test("the client-credentials form", () => {
    const f = clientCredentialsForm("abc", "cas_secret");
    expect(Object.fromEntries(f)).toEqual({
      grant_type: "client_credentials",
      client_id: "abc",
      client_secret: "cas_secret",
    });
  });

  test("the OAuth error code, or null", () => {
    expect(oauthErrorCode({ error: "invalid_client", error_description: "x" })).toBe("invalid_client");
    expect(oauthErrorCode({ error: "not_a_code" })).toBeNull();
    expect(oauthErrorCode(null)).toBeNull();
    expect(oauthErrorCode("invalid_client")).toBeNull();
  });

  test("the report summary never carries the secret", () => {
    const s = appSummary({
      id: "i",
      clientId: "c",
      clientSecret: "cas_topsecret",
      redirectUri: "http://127.0.0.1:1/cb",
    });
    expect(s).toEqual({ id: "i", clientId: "c", confidential: true, redirectUri: "http://127.0.0.1:1/cb" });
    expect(JSON.stringify(s)).not.toContain("cas_topsecret");
    expect(appSummary({ id: "i", clientId: "c", clientSecret: null, redirectUri: "x" }).confidential).toBe(false);
  });
});

describe("step 8 helpers", () => {
  test("the EventSub WebSocket URL from the API base", () => {
    expect(eventSubUrl("http://localhost:3001")).toBe("ws://localhost:3001/eventsub/ws");
    expect(eventSubUrl("https://api.example.test/")).toBe("wss://api.example.test/eventsub/ws");
  });

  const req = (over: Partial<{ method: string; path: string; type: string; body: string }> = {}) => ({
    method: over.method ?? "POST",
    path: over.path ?? "/hook",
    headers: { [WEBHOOK_HEADERS.messageType]: over.type ?? "revocation" },
    body: over.body ?? JSON.stringify({ subscription: { id: "sub-1", status: "authorization_revoked" } }),
  });

  test("a revocation for this subscription, and nothing else", () => {
    expect(isRevocationFor(req(), "sub-1")).toBe(true);
    expect(isRevocationFor(req(), "sub-2")).toBe(false);
    expect(isRevocationFor(req({ type: "notification" }), "sub-1")).toBe(false);
    expect(isRevocationFor(req({ path: "/cb" }), "sub-1")).toBe(false);
    expect(isRevocationFor(req({ method: "GET" }), "sub-1")).toBe(false);
    expect(isRevocationFor(req({ body: "not json" }), "sub-1")).toBe(false);
    expect(isRevocationFor(req({ body: "{}" }), "sub-1")).toBe(false);
  });
});

describe("step modules", () => {
  test("both are E9-apps's and ready; 8 needs 4 and 5", () => {
    expect([appStep.owner, suspendStep.owner]).toEqual(["E9-apps", "E9-apps"]);
    expect([appStep.ready, suspendStep.ready]).toEqual([true, true]);
    expect(appStep.needs).toEqual([]);
    expect(suspendStep.needs).toEqual([4, 5]);
    expect(appStep.webOnly).toBeUndefined();
    expect(suspendStep.webOnly).toBeUndefined();
  });
});
