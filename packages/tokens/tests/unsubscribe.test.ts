// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { b64url, fromB64url, signUnsubscribeToken, verifyUnsubscribeToken } from "../src/index.ts";

const S = "x".repeat(40);
const USER = "019a0000-0000-7000-8000-00000000abcd";

function flipBit(part: string): string {
  const bytes = fromB64url(part);
  bytes[3] = bytes[3]! ^ 0x01;
  return b64url(bytes);
}

describe("unsubscribe tokens", () => {
  test("round trip, URL-safe", async () => {
    const t = await signUnsubscribeToken(S, USER, "go_live");
    expect(t).toMatch(/^v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(t).not.toMatch(/[+/=]/);
    expect(encodeURIComponent(t)).toBe(t);
    expect(await verifyUnsubscribeToken(S, t, "go_live")).toBe(USER);
  });

  test("deterministic (no expiry, no nonce)", async () => {
    expect(await signUnsubscribeToken(S, USER, "go_live")).toBe(await signUnsubscribeToken(S, USER, "go_live"));
  });

  test("another list or another secret → null", async () => {
    const t = await signUnsubscribeToken(S, USER, "go_live");
    expect(await verifyUnsubscribeToken(S, t, "governance")).toBeNull();
    expect(await verifyUnsubscribeToken("y".repeat(40), t, "go_live")).toBeNull();
  });

  test("a flipped bit in either part → null", async () => {
    const [v, id, mac] = (await signUnsubscribeToken(S, USER, "go_live")).split(".");
    expect(await verifyUnsubscribeToken(S, `${v}.${flipBit(id!)}.${mac}`, "go_live")).toBeNull();
    expect(await verifyUnsubscribeToken(S, `${v}.${id}.${flipBit(mac!)}`, "go_live")).toBeNull();
  });

  test("malformed tokens → null", async () => {
    const t = await signUnsubscribeToken(S, USER, "go_live");
    const [, id, mac] = t.split(".");
    for (const bad of [
      "",
      "v1",
      `v1.${id}`,
      `v2.${id}.${mac}`,
      `${t}.extra`,
      `v1.${id}.${mac!.slice(0, -2)}`,
      `v1.${id!.slice(0, -2)}.${mac}`,
      `v1.${id}.${mac}=`,
      `v1.${id}+.${mac}`,
      `v1.!!!!.${mac}`,
      // 15 bytes is not a UUID.
      `v1.${b64url(fromB64url(id!).slice(0, 15))}.${mac}`,
    ]) {
      expect(await verifyUnsubscribeToken(S, bad, "go_live"), bad).toBeNull();
    }
  });

  test("signing refuses a non-UUID user id", async () => {
    await expect(signUnsubscribeToken(S, "not-a-uuid", "go_live")).rejects.toThrow(/UUID/);
  });
});
