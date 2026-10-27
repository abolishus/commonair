// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `/p2p-digest/` seam (P1 contract step). P1-tracker replaces the 501 assertion. */
import { describe, expect, test } from "vite-plus/test";
import type { Executor } from "@commonair/db";
import type { ValkeyClient } from "@commonair/service";
import { generateSigningKey } from "@commonair/tokens";
import { createOrigin } from "../src/origin.ts";
import { P2P_DIGEST_ROUTE } from "../src/p2p-digest.ts";

async function origin() {
  const { pkcs8B64 } = await generateSigningKey();
  // No request below reaches the database, Valkey or MediaMTX.
  return createOrigin({
    db: {} as Executor,
    valkey: {} as ValkeyClient,
    playbackSigningKey: pkcs8B64,
    mediamtxHlsUrl: "http://127.0.0.1:9",
    internalSecret: "s".repeat(32),
    mediaPassword: "p".repeat(32),
    cacheMb: 1,
    cdn: { provider: "none" },
  });
}

describe("p2p digest route", () => {
  test("the route", () => {
    expect(P2P_DIGEST_ROUTE).toBe("/p2p-digest/");
  });

  test("/p2p-digest/ reaches the digest handler (stub: 501, with CORS)", async () => {
    const o = await origin();
    const r = await o.fetch(new Request("http://o/p2p-digest/live/test/seg1.mp4?t=x"));
    expect(r.status).toBe(501);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("/hls/ is unchanged: a request without a valid token is refused by the HLS handler", async () => {
    const o = await origin();
    const r = await o.fetch(new Request("http://o/hls/live/test/seg1.mp4"));
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toMatch(/^forbidden: /);
  });
});
