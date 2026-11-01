// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The plugin registry (batch 7 contract step §5.4): the giveaway plugin is registered and passes messages through. */
import { describe, expect, test } from "vite-plus/test";
import { createGiveawayMiddleware } from "../src/plugins/giveaway.ts";
import { plugins } from "../src/plugins/index.ts";
import { runSendPipeline } from "../src/pipeline.ts";
import { deps, input } from "./fixtures.ts";

describe("plugin registry", () => {
  test("registers the giveaway plugin last, with the flag off by default", () => {
    expect(plugins().map((p) => p.name)).toEqual(["noop", "channel-bot", "giveaway"]);
    expect(plugins({ giveaways: true }).map((p) => p.name)).toEqual(["noop", "channel-bot", "giveaway"]);
  });

  test("the giveaway plugin lets every message through, on or off", async () => {
    for (const enabled of [false, true]) {
      const mw = createGiveawayMiddleware({ enabled });
      const r = await runSendPipeline(deps([mw]), input({ body: "!enter" }));
      expect(r).toMatchObject({ ok: true, body: "!enter" });
    }
  });
});
