// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { decodeReplayCursor, encodeReplayCursor } from "../src/chat-replay/cursor.ts";
import { agedOut } from "../src/chat-replay/query.ts";

const ID = "01a18b98-999f-7ec4-81d0-7a942e2896ae";

describe("replay cursor", () => {
  test("round-trips microsecond time and id, opaquely", () => {
    const c = { t: "2026-10-30T12:00:00.123456Z", id: ID };
    const raw = encodeReplayCursor(c);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(raw).not.toContain("2026");
    expect(decodeReplayCursor(raw)).toEqual(c);
  });

  test("absent is null", () => {
    expect(decodeReplayCursor(undefined)).toBeNull();
    expect(decodeReplayCursor("")).toBeNull();
  });

  test("malformed is a client error", () => {
    const bad = [
      "not base64 json",
      Buffer.from("[]").toString("base64url"),
      encodeReplayCursor({ t: "2026-10-30T12:00:00.123Z", id: ID }),
      encodeReplayCursor({ t: "2026-10-30T12:00:00.123456Z", id: "x" }),
      encodeReplayCursor({ t: "yesterday", id: ID }),
      Buffer.from(JSON.stringify({ t: "2026-10-30T12:00:00.123456Z" })).toString("base64url"),
    ];
    for (const raw of bad) expect(() => decodeReplayCursor(raw), raw).toThrow("Invalid cursor");
  });
});

describe("agedOut (ADR 0012 amendment 1 decision 6)", () => {
  const env = { CHAT_RETENTION_DAYS: 30, CHAT_REPLAY_MAX_DAYS: 60 };
  const now = new Date("2026-10-30T12:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);

  test("without a live VOD: the retention days", () => {
    expect(agedOut(ago(30), now, false, env)).toBe(false);
    expect(agedOut(new Date(ago(30).getTime() - 1), now, false, env)).toBe(true);
  });

  test("with a live VOD: the replay maximum", () => {
    expect(agedOut(ago(45), now, true, env)).toBe(false);
    expect(agedOut(ago(60), now, true, env)).toBe(false);
    expect(agedOut(new Date(ago(60).getTime() - 1), now, true, env)).toBe(true);
  });
});
