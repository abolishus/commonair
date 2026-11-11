// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** w5-watch: the /following alert selectors and the N1 per-channel ids now render in the following components. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { N1_TEST_IDS } from "../src/n1/selectors.ts";
import { TEST_IDS, W5_WATCH_IDS } from "../src/web/selectors.ts";

const DIR = new URL("../../apps/web/src/components/following/", import.meta.url).pathname;
const source = readdirSync(DIR)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => readFileSync(join(DIR, f), "utf8"))
  .join("\n");
const asAttribute = (id: string) => new RegExp(`data-testid=\\{?["'\`]${id}["'\`]`);

describe("W5_WATCH_IDS", () => {
  test.each(Object.entries(W5_WATCH_IDS))("%s (%s) is a test id in the following components", (_name, id) => {
    expect(source).toMatch(asAttribute(id));
  });

  test("the values are unique and do not collide with the shared ids", () => {
    const values = Object.values(W5_WATCH_IDS);
    expect(new Set(values).size).toBe(values.length);
    const shared = new Set<string>(Object.values(TEST_IDS));
    expect(values.filter((v) => shared.has(v))).toEqual([]);
  });

  test("the N1 per-channel ids moved here with the controls", () => {
    for (const id of [
      N1_TEST_IDS.channel,
      N1_TEST_IDS.channelBell,
      N1_TEST_IDS.channelEmail,
      N1_TEST_IDS.channelEmailDefault,
      N1_TEST_IDS.channelEmailOn,
      N1_TEST_IDS.channelEmailOff,
      N1_TEST_IDS.channelPush,
      N1_TEST_IDS.channelPushDefault,
      N1_TEST_IDS.channelPushOn,
      N1_TEST_IDS.channelPushOff,
    ])
      expect(source, id).toMatch(asAttribute(id));
  });
});
