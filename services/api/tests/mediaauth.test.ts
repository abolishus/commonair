// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { MEDIA_INTERNAL_USER, MediaMtxAuthRequest } from "@commonair/contracts/internal";
import { decidePublish, internalCredentialsOk, planMediaAuth, presentedSecret } from "../src/media/auth.ts";
import { ingestProtocolOf } from "../src/media/hooks.ts";

const SECRET = "x".repeat(40);
const req = (over: Partial<MediaMtxAuthRequest>) =>
  MediaMtxAuthRequest.parse({ ip: "10.0.0.1", action: "publish", protocol: "rtmp", path: "live/alice", ...over });

describe("planMediaAuth decision table", () => {
  test.each([
    // action, path, protocol, expected plan kind
    ["publish", "live/alice", "rtmp", "publish"],
    ["publish", "live/alice", "webrtc", "publish"],
    ["publish", "live/alice/720p", "rtsp", "internal"],
    ["publish", "live/alice/source", "rtsp", "deny"],
    ["publish", "live/Alice", "rtmp", "deny"],
    ["publish", "other/alice", "rtmp", "deny"],
    ["publish", "live/a", "rtmp", "deny"],
    ["publish", "live/alice/../bob", "rtmp", "deny"],
    ["read", "live/alice", "rtsp", "internal"],
    ["read", "live/alice", "hls", "internal"],
    ["playback", "live/alice", "hls", "internal"],
    ["api", "", "hls", "internal"],
    ["metrics", "", "hls", "internal"],
    ["pprof", "", "hls", "deny"],
  ] as const)("%s %s via %s → %s", (action, path, protocol, kind) => {
    expect(planMediaAuth(req({ action, path, protocol })).kind).toBe(kind);
  });

  test("publish secret: RTMP query key, WHIP bearer token, then password", () => {
    expect(presentedSecret(req({ query: "key=abc&x=1" }))).toBe("abc");
    expect(presentedSecret(req({ protocol: "webrtc", token: "tok" }))).toBe("tok");
    expect(presentedSecret(req({ password: "pw" }))).toBe("pw");
    expect(presentedSecret(req({ user: "someone", password: "pw" }))).toBeNull();
    expect(presentedSecret(req({}))).toBeNull();
    const plan = planMediaAuth(req({ query: "key=abc" }));
    expect(plan).toEqual({ kind: "publish", slug: "alice", secret: "abc" });
  });
});

test("internal credentials: exact user and secret only", () => {
  expect(internalCredentialsOk({ user: MEDIA_INTERNAL_USER, password: SECRET }, SECRET)).toBe(true);
  expect(internalCredentialsOk({ user: MEDIA_INTERNAL_USER, password: `${SECRET}x` }, SECRET)).toBe(false);
  expect(internalCredentialsOk({ user: "admin", password: SECRET }, SECRET)).toBe(false);
  expect(internalCredentialsOk({ user: "", password: "" }, SECRET)).toBe(false);
});

test.each([
  [{ channelExists: true, channelSuspended: false, ownerSuspended: false, keyMatches: true }, true],
  [{ channelExists: false, channelSuspended: false, ownerSuspended: false, keyMatches: true }, false],
  [{ channelExists: true, channelSuspended: true, ownerSuspended: false, keyMatches: true }, false],
  [{ channelExists: true, channelSuspended: false, ownerSuspended: true, keyMatches: true }, false],
  [{ channelExists: true, channelSuspended: false, ownerSuspended: false, keyMatches: false }, false],
])("decidePublish(%o) → %s", (facts, ok) => {
  expect(decidePublish(facts)).toBe(ok);
});

test("MediaMTX source types map to ingest protocols", () => {
  expect(ingestProtocolOf("rtmpConn")).toBe("rtmp");
  expect(ingestProtocolOf("webRTCSession")).toBe("whip");
  expect(ingestProtocolOf("srtConn")).toBe("srt");
  expect(ingestProtocolOf("rtspSession")).toBe("rtsp");
  expect(ingestProtocolOf("unknown")).toBe("rtmp");
});
