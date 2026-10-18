// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { decryptSecret, encryptSecret, signChatToken, verifyChatToken } from "../src/secrets.ts";

const S = "x".repeat(40);

describe("encryptSecret", () => {
  test("round-trips, is randomized, and is bound to secret and purpose", async () => {
    const a = await encryptSecret(S, "simulcast", "live_abc");
    const b = await encryptSecret(S, "simulcast", "live_abc");
    expect(a).not.toBe(b);
    expect(await decryptSecret(S, "simulcast", a)).toBe("live_abc");
    await expect(decryptSecret(S, "webhook", a)).rejects.toThrow(/decrypt|operation/i);
    await expect(decryptSecret("y".repeat(40), "simulcast", a)).rejects.toThrow(/decrypt|operation/i);
    await expect(decryptSecret(S, "simulcast", "v2.abc")).rejects.toThrow(/version/);
  });
});

describe("chat tokens", () => {
  const claims = {
    v: 1 as const,
    uid: "01890000-0000-7000-8000-000000000001",
    app: null,
    scopes: ["chat:read", "chat:edit"],
    exp: 2_000_000_000,
  };
  test("verify, and reject tampering, wrong secret and expiry", async () => {
    const t = await signChatToken(S, claims);
    expect(await verifyChatToken(S, t, 1_900_000_000)).toEqual(claims);
    expect(await verifyChatToken("z".repeat(40), t, 1_900_000_000)).toBeNull();
    expect(await verifyChatToken(S, t, 2_000_000_001)).toBeNull();
    const [, mac] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, uid: "01890000-0000-7000-8000-000000000009" })).toString(
      "base64url",
    );
    expect(await verifyChatToken(S, `${forged}.${mac}`, 1_900_000_000)).toBeNull();
    expect(await verifyChatToken(S, "nope", 1_900_000_000)).toBeNull();
  });
});
