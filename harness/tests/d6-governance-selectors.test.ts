// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** d6-governance: every co-op governance selector the harness names is rendered by the web app's source. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { E5_TEST_IDS } from "../src/coop-selectors.ts";
import { D6_GOVERNANCE_IDS, TEST_IDS } from "../src/web/selectors.ts";

const WEB = new URL("../../apps/web/src/components/", import.meta.url).pathname;
const DIRS = ["governance", "coop"];
const source = DIRS.flatMap((d) =>
  readdirSync(join(WEB, d))
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => readFileSync(join(WEB, d, f), "utf8")),
).join("\n");

describe("D6_GOVERNANCE_IDS", () => {
  test.each(Object.entries(D6_GOVERNANCE_IDS))("%s (%s) is a test id in the governance components", (_name, id) => {
    // As a JSX attribute, a `…Props` entry, or one of the join gate's `testIds`.
    expect(source).toMatch(
      new RegExp(`(data-testid=\\{?["'\`]${id}["'\`]|"data-testid": "${id}"|(create|signIn): "${id}")`),
    );
  });

  test("the values are unique and do not collide with the shared or E5 ids", () => {
    const values = Object.values(D6_GOVERNANCE_IDS);
    expect(new Set(values).size).toBe(values.length);
    const taken = new Set<string>([...Object.values(TEST_IDS), ...Object.values(E5_TEST_IDS)]);
    expect(values.filter((v) => taken.has(v))).toEqual([]);
  });

  test("the E5 ids the proposal flow drives are still rendered", () => {
    for (const id of [
      E5_TEST_IDS.proposalChange,
      E5_TEST_IDS.proposalChangeKey,
      E5_TEST_IDS.proposalChangeValue,
      E5_TEST_IDS.proposalChangeAdd,
      E5_TEST_IDS.proposalKind,
      E5_TEST_IDS.proposalChangeSummary,
      E5_TEST_IDS.settingRow,
      E5_TEST_IDS.voteParticipation,
    ])
      expect(source, id).toMatch(new RegExp(`(data-testid=\\{?["'\`]${id}["'\`]|"data-testid": "${id}")`));
  });
});
