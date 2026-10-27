// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `requestVodPlacement` never throws and never holds a committed request open on a Valkey outage. */
import { describe, expect, test } from "vite-plus/test";
import type { Deps } from "../src/deps.ts";
import { requestVodPlacement, setVodPlacementQueue, type VodPlacementQueue } from "../src/media/vod-placement-queue.ts";

function fakeDeps(queue: VodPlacementQueue) {
  const warnings: { msg: string; fields: unknown }[] = [];
  const logger = { warn: (msg: string, fields: unknown) => warnings.push({ msg, fields }) };
  const deps = { logger } as unknown as Deps;
  setVodPlacementQueue(deps, queue);
  return { deps, warnings };
}

const VOD = "0190a3a0-0000-7000-8000-000000000001";

describe("requestVodPlacement", () => {
  test("enqueues the VOD and logs nothing", async () => {
    const got: string[] = [];
    const { deps, warnings } = fakeDeps({ enqueue: async (id) => void got.push(id), close: async () => {} });
    await requestVodPlacement(deps, VOD);
    expect(got).toEqual([VOD]);
    expect(warnings).toEqual([]);
  });

  test("a failed enqueue is logged with the VOD id only, never thrown", async () => {
    const { deps, warnings } = fakeDeps({
      enqueue: async () => {
        throw new Error("valkey down");
      },
      close: async () => {},
    });
    await requestVodPlacement(deps, VOD);
    expect(warnings).toEqual([{ msg: expect.stringContaining("failed"), fields: { vodId: VOD } }]);
  });

  test("an enqueue stuck behind a Valkey outage gives up after the timeout", async () => {
    let settle: (err: Error) => void = () => {};
    const { deps, warnings } = fakeDeps({
      enqueue: () => new Promise<void>((_, reject) => (settle = reject)),
      close: async () => {},
    });
    const started = Date.now();
    await requestVodPlacement(deps, VOD, 50);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warnings).toEqual([{ msg: expect.stringContaining("timed out"), fields: { vodId: VOD } }]);
    // Failing after the timeout is not an unhandled rejection and logs nothing more.
    settle(new Error("valkey down"));
    await Bun.sleep(10);
    expect(warnings).toHaveLength(1);
  });
});
