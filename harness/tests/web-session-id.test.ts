// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { WEB_PLAYBACK_START_PATH, sessionIdFromRpcStart } from "../src/browser-viewer.ts";

// The first viewers run with P2P (2026-10-28) failed "default viewers hold no P2P grant": the web
// embed has no window.__harness, so a web viewer's session id was always null.
describe("sessionIdFromRpcStart", () => {
  test("reads the session id from oRPC's RPC body", () => {
    expect(sessionIdFromRpcStart({ json: { sessionId: "0197-abc", token: "t" }, meta: [] })).toBe("0197-abc");
  });

  test("anything else is null", () => {
    for (const body of [
      null,
      undefined,
      "x",
      1,
      {},
      { json: null },
      { json: {} },
      { json: { sessionId: "" } },
      { json: { sessionId: 7 } },
      { sessionId: "flat" },
    ]) {
      expect(sessionIdFromRpcStart(body)).toBeNull();
    }
  });

  test("the path is the web client's playback.start", () => {
    expect(WEB_PLAYBACK_START_PATH).toBe("/rpc/playback/start");
  });
});
