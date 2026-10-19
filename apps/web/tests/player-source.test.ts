// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import { heartbeatSwitch, playerSource, sourceAfterSwitch, tokenSource } from "../src/player/source.ts";

/** A playback token as the API signs it: base64url JSON claims, a dot, a signature. */
function token(claims: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2lnbmF0dXJl`;
}

const claims = (src: string, extra: Record<string, unknown> = {}) => ({
  v: 1,
  sid: "0190f5d2-0000-7000-8000-000000000001",
  cid: "0190f5d2-0000-7000-8000-000000000002",
  path: "live/abc",
  src,
  iat: 1,
  exp: 2,
  ...extra,
});

describe("playerSource", () => {
  it("passes HTTP sources through and never reports p2p", () => {
    expect(playerSource("origin")).toBe("origin");
    expect(playerSource("relay")).toBe("relay");
    expect(playerSource("cdn")).toBe("cdn");
    expect(playerSource("p2p")).toBe("origin");
  });
});

describe("tokenSource", () => {
  it("reads the src claim", () => {
    expect(tokenSource(token(claims("origin")))).toBe("origin");
    expect(tokenSource(token(claims("relay", { rid: "0190f5d2-0000-7000-8000-000000000003" })))).toBe("relay");
    expect(tokenSource(token(claims("cdn")))).toBe("cdn");
  });

  it("handles non-ASCII claims", () => {
    expect(tokenSource(token(claims("cdn", { path: "live/ü" })))).toBe("cdn");
  });

  it("is null for missing, malformed or unknown tokens", () => {
    expect(tokenSource(undefined)).toBeNull();
    expect(tokenSource("")).toBeNull();
    expect(tokenSource("not base64!.sig")).toBeNull();
    expect(tokenSource(`${Buffer.from("not json").toString("base64url")}.sig`)).toBeNull();
    expect(tokenSource(token(claims("satellite")))).toBeNull();
    expect(tokenSource(token({ v: 1 }))).toBeNull();
    expect(tokenSource(`${Buffer.from("[1]").toString("base64url")}.sig`)).toBeNull();
  });
});

describe("sourceAfterSwitch", () => {
  it("uses the refreshed token's source", () => {
    expect(sourceAfterSwitch(token(claims("origin")))).toBe("origin");
    expect(sourceAfterSwitch(token(claims("cdn")))).toBe("cdn");
  });

  it("falls back to the origin, where a relay leaving sends viewers", () => {
    expect(sourceAfterSwitch(undefined)).toBe("origin");
    expect(sourceAfterSwitch("garbage")).toBe("origin");
    expect(sourceAfterSwitch(token(claims("p2p")))).toBe("origin");
  });
});

describe("heartbeatSwitch", () => {
  const url = "http://localhost:3003/hls/live/abc/index.m3u8?t=x";

  it("stays put without switchTo", () => {
    expect(heartbeatSwitch({})).toBeNull();
    expect(heartbeatSwitch({ token: token(claims("origin")) })).toBeNull();
  });

  it("moves to the new playlist with its source", () => {
    expect(heartbeatSwitch({ switchTo: url, token: token(claims("origin")) })).toEqual({ url, source: "origin" });
    expect(heartbeatSwitch({ switchTo: url })).toEqual({ url, source: "origin" });
  });

  it("ignores a throttled beat", () => {
    expect(heartbeatSwitch({ switchTo: url, throttled: true })).toBeNull();
  });
});
