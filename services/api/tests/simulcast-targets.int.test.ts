// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** E6: target changes reach media mid-broadcast (`simulcast-targets` on BUS.live); disabled reads idle. */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BUS } from "@commonair/contracts/events";
import { signUpAndSignIn, startApi, subscriber, waitFor, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api?.stop();
});

describe("simulcast target changes", () => {
  test("create, update and remove publish simulcast-targets; a disabled target reads idle", async () => {
    const s = await signUpAndSignIn(api);
    const sub = subscriber();
    const seen: { type: string; channelId: string }[] = [];
    sub.on("message", (_ch: string, raw: string) => seen.push(JSON.parse(raw) as { type: string; channelId: string }));
    await sub.subscribe(BUS.live);
    try {
      const base = `/api/channels/${s.username}/simulcast`;
      const created = await s.client.call<{ id: string; status: string }>("POST", base, {
        platform: "custom",
        name: "Mock",
        rtmpUrl: "rtmp://127.0.0.1:1936/live",
        streamKey: "harness-key",
        enabled: true,
      });
      expect(created.status).toBe(200);
      const id = created.body.id;
      const changes = () => seen.filter((e) => e.type === "simulcast-targets").length;
      await waitFor(async () => (changes() >= 1 ? true : null));

      const disabled = await s.client.call<{ status: string; enabled: boolean }>("PATCH", `${base}/${id}`, {
        enabled: false,
      });
      expect(disabled.body).toMatchObject({ enabled: false, status: "idle" });
      await waitFor(async () => (changes() >= 2 ? true : null));

      expect((await s.client.call("DELETE", `${base}/${id}`)).status).toBe(200);
      await waitFor(async () => (changes() >= 3 ? true : null));
      const channelIds = new Set(seen.filter((e) => e.type === "simulcast-targets").map((e) => e.channelId));
      expect(channelIds.size).toBe(1);
      // The key never travels on the bus.
      expect(JSON.stringify(seen)).not.toContain("harness-key");
    } finally {
      await sub.quit();
    }
  });
});
