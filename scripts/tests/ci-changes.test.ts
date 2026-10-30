// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { FULL_SHARDS } from "../../harness/src/shards.ts";
import {
  ALL,
  EVERYTHING,
  type ImportGraph,
  changesFor,
  classify,
  harnessGraph,
  isDeploy,
  isDocsOnly,
  isTestOnly,
  outputs,
  scenariosReaching,
  selectScenarios,
  shardsFor,
} from "../ci-changes.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("isDocsOnly", () => {
  test.each([
    ".claude/briefs/e8/E8-polls.md",
    "PROGRESS.md",
    "README.md",
    "docs/decisions/0035-sdk-license.md",
    "harness/README.md",
  ])("%s is prose", (p) => expect(isDocsOnly(p)).toBe(true));

  test.each([
    "docs/testing/e9-selectors.md", // apps/web/tests/selectors.test.ts reads it
    "docs/self-hosting/configuration.md", // config-reference --check
    "docs/developers/oauth.md", // the console docs test
    "packages/db/src/legal/terms.md", // seeded
    "packages/db/src/legal/README.md",
    "docs/brand/banner.svg",
    "apps/web/src/i18n/locales/en/core.json",
    "harness/src/e9/consent.ts",
  ])("%s is not", (p) => expect(isDocsOnly(p)).toBe(false));
});

describe("isTestOnly", () => {
  test.each([
    "services/api/tests/e9-subs.int.test.ts",
    "harness/tests/e9/consent.test.ts",
    "apps/web/src/components/oauth/consent.test.tsx",
    "packages/ui/src/blocks/feedback.stories.tsx",
  ])("%s", (p) => expect(isTestOnly(p)).toBe(true));
  test.each(["services/api/src/oauth/tokens.ts", "harness/src/e9/consent.ts", "packages/db/src/testing.ts"])(
    "%s is not",
    (p) => expect(isTestOnly(p)).toBe(false),
  );
});

describe("isDeploy", () => {
  test.each([
    "infra/caddy/Caddyfile",
    "infra/containers/api.Containerfile",
    "scripts/selfhost.sh",
    "scripts/selfhost/e2e.ts",
    "scripts/release/ci-summary.ts",
    "scripts/infra.ts",
    "compose.yaml",
    "harness/compose.e9.yaml",
    ".github/workflows/ci.yml",
    "bun.lock",
    "package.json",
    "relay/go.sum",
    "packages/db/drizzle/0036_n2_locale.sql",
    ".env.example",
  ])("%s", (p) => expect(isDeploy(p)).toBe(true));

  test.each(["apps/web/package.json", "services/api/src/oauth/tokens.ts", "harness/src/e9/consent.ts", "PROGRESS.md"])(
    "%s is not",
    (p) => expect(isDeploy(p)).toBe(false),
  );
});

/** a ← shared ← { s1, s2 }; only ← s2; helper `_h` ← s1; `orphan` reached by nothing. */
const GRAPH: ImportGraph = new Map([
  ["harness/scenarios/s1.ts", ["harness/src/shared.ts", "harness/scenarios/_h.ts"]],
  ["harness/scenarios/s2.ts", ["harness/src/shared.ts", "harness/src/only.ts"]],
  ["harness/scenarios/_h.ts", []],
  ["harness/src/shared.ts", ["harness/src/a.ts"]],
  ["harness/src/a.ts", []],
  ["harness/src/only.ts", []],
  ["harness/src/orphan.ts", []],
]);

describe("selectScenarios", () => {
  test.each<[string[], readonly string[] | typeof ALL]>([
    [["PROGRESS.md", "services/api/tests/x.int.test.ts"], []],
    [["harness/src/only.ts"], ["s2"]],
    [["harness/src/a.ts"], ["s1", "s2"]], // transitively
    [["harness/scenarios/_h.ts"], ["s1"]], // a helper module is not a scenario of its own
    [["harness/scenarios/s1.ts", "harness/tests/s1.test.ts"], ["s1"]],
    [["harness/src/orphan.ts"], ALL], // harness runtime no scenario imports (cli, runner)
    [["harness/src/gone.ts"], ALL], // deleted, or not a module the graph knows
    [["harness/src/only.ts", "services/api/src/x.ts"], ALL],
    [["harness/compose.e9.yaml"], ALL],
    [["apps/web/src/routes/index.tsx"], ALL],
  ])("%o → %o", (files, want) => expect(selectScenarios(files, GRAPH)).toEqual(want));

  test("reaching walks the graph, not just direct imports", () => {
    expect(scenariosReaching("harness/src/a.ts", GRAPH)).toEqual(["s1", "s2"]);
  });
});

describe("the real harness graph", () => {
  const graph = harnessGraph(ROOT);

  test("finds every scenario module and no tests", () => {
    expect(graph.has("harness/scenarios/developer-platform.ts")).toBe(true);
    expect(graph.has("harness/tests/e9/consent.test.ts")).toBe(false);
  });

  test("the E8 kit reaches the E9 scenario too (harness/src/e9/run.ts imports it)", () => {
    expect(scenariosReaching("harness/src/e8/kit.ts", graph)).toEqual(
      expect.arrayContaining(["channel-bot", "developer-platform", "interact"]),
    );
  });

  test("the platform reaches many scenarios; the CLI reaches none, so it selects all", () => {
    expect(scenariosReaching("harness/src/platform.ts", graph).length).toBeGreaterThan(5);
    expect(selectScenarios(["harness/src/cli.ts"], graph)).toBe(ALL);
  });
});

describe("shardsFor and outputs", () => {
  test("all → every shard", () => expect(shardsFor(ALL)).toEqual(Object.keys(FULL_SHARDS)));
  test("a named shard's scenario → that shard; any other → rest", () => {
    expect(shardsFor(["interact", "developer-platform"])).toEqual(["interact", "rest"]);
    expect(shardsFor(["clock-skew"])).toEqual(["clock"]);
  });
  test("nothing selected: code false, and a non-empty shard list for the skipped matrix", () => {
    expect(outputs({ scenarios: [], deploy: false })).toBe(
      `code=false\nscenarios=\nshards=${JSON.stringify(Object.keys(FULL_SHARDS))}\ndeploy=false\n`,
    );
    expect(outputs({ scenarios: ["interact"], deploy: true })).toBe(
      'code=true\nscenarios=interact\nshards=["interact"]\ndeploy=true\n',
    );
    expect(outputs(EVERYTHING)).toContain("scenarios=all\n");
  });
});

describe("changesFor", () => {
  test.each([
    { EVENT_NAME: "schedule", BASE: "a", SHA: "b" },
    { EVENT_NAME: "workflow_dispatch" },
    { EVENT_NAME: "push", BASE: "", SHA: "b" },
    { EVENT_NAME: "push", BASE: "0000000000000000000000000000000000000000", SHA: "b" },
    { EVENT_NAME: "push", BASE: "not-a-commit", SHA: "also-not" },
  ])("everything for %o", (env) => expect(changesFor(env, ROOT)).toEqual(EVERYTHING));

  test("real ranges in this repository", () => {
    // PROGRESS.md only.
    expect(changesFor({ EVENT_NAME: "push", BASE: "4a29455~1", SHA: "4a29455" }, ROOT)).toEqual({
      scenarios: [],
      deploy: false,
    });
    // The consent race fix: harness/src/e9/consent.ts and its unit test.
    expect(changesFor({ EVENT_NAME: "push", BASE: "1c4266f", SHA: "d51c084" }, ROOT)).toEqual({
      scenarios: ["developer-platform"],
      deploy: false,
    });
  });

  test("classify combines the selection with the deploy check", () => {
    expect(classify(["packages/db/drizzle/0037_x.sql"], GRAPH)).toEqual({ scenarios: ALL, deploy: true });
  });
});
