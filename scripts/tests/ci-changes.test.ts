// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { FULL_SHARDS, PATH_FILTERED_SHARDS } from "../../harness/src/shards.ts";
import {
  ALL,
  EVERYTHING,
  type ImportGraph,
  changesFor,
  classify,
  filteredShardsReached,
  harnessGraph,
  isDeploy,
  isDocsOnly,
  isTestOnly,
  matrixShards,
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
    "docs/design/2026-11-review/02-home-desktop.jpg",
    "docs/design/2026-11-review/07-live-player-hover.png",
  ])("%s is prose", (p) => expect(isDocsOnly(p)).toBe(true));

  test.each([
    "docs/testing/e9-selectors.md", // apps/web/tests/selectors.test.ts reads it
    "docs/self-hosting/configuration.md", // config-reference --check
    "docs/developers/oauth.md", // the console docs test
    "packages/db/src/legal/terms.md", // seeded
    "packages/db/src/legal/README.md",
    "docs/brand/banner.svg",
    "docs/brand/logo.png",
    "docs/testing/screenshot.png",
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

  // Batch 7 decision (d): the w3 shard is an ordinary shard. The CI matrix is built from FULL_SHARDS
  // (outputs → `shards`), so it needs no workflow change and runs on every push selecting all.
  test("a batch 7 scenario module selects its scenario and the w3 shard, which is never filtered", () => {
    expect(scenariosReaching("harness/src/n3/index.ts", graph)).toEqual(["twitch-import"]);
    expect(scenariosReaching("harness/src/w3/watch-rooms/index.ts", graph)).toEqual(["watch-room"]);
    // seed-coverage runs seed full, whose seed-interact drives giveaways through this module;
    // d-surfaces reads that run's store (seed/run.ts).
    expect(scenariosReaching("harness/src/w3/giveaways.ts", graph)).toEqual([
      "d-surfaces",
      "interact",
      "seed-coverage",
    ]);
    expect(shardsFor(selectScenarios(["harness/src/n4/web.ts"], graph))).toEqual(["w3"]);
    expect(matrixShards({ scenarios: ALL, deploy: false, filteredShards: [] })).toContain("w3");
    expect(outputs({ scenarios: ["portability"], deploy: false, filteredShards: [] })).toContain('shards=["w3"]');
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
    expect(outputs({ scenarios: [], deploy: false, filteredShards: [] })).toBe(
      `code=false\nscenarios=\nshards=${JSON.stringify(Object.keys(FULL_SHARDS))}\ndeploy=false\ndocs=false\n`,
    );
    expect(outputs({ scenarios: ["interact"], deploy: true, filteredShards: [] })).toBe(
      'code=true\nscenarios=interact\nshards=["interact"]\ndeploy=true\ndocs=false\n',
    );
    expect(outputs(EVERYTHING)).toContain("scenarios=all\n");
    expect(outputs(EVERYTHING)).toContain("docs=false\n");
  });

  test("docs alone: docs true, so the gate runs its static group only", () => {
    const docs = classify(["PLAN.md", ".claude/briefs/d/README.md", "docs/design/2026-11-review/01-a.jpg"], GRAPH);
    expect(docs).toEqual({ scenarios: [], deploy: false, filteredShards: [], docsOnly: true });
    expect(outputs(docs)).toContain("code=false\n");
    expect(outputs(docs)).toContain("docs=true\n");
    // A test, or anything else, alongside the docs runs the whole gate.
    expect(classify(["PLAN.md", "scripts/tests/ci-changes.test.ts"], GRAPH).docsOnly).toBeUndefined();
    expect(classify(["PLAN.md", "apps/web/src/main.tsx"], GRAPH).docsOnly).toBeUndefined();
  });
});

// Batch 6 decision (c): the captions shard (whisper and its weights) runs on pushes that reach
// captions, media or origin code, and on every nightly run and dispatch.
describe("path-filtered shards", () => {
  const filtered = Object.keys(PATH_FILTERED_SHARDS);
  const without = Object.keys(FULL_SHARDS).filter((s) => !filtered.includes(s));

  test("every path-filtered shard is a full shard: captions and seed", () => {
    for (const s of filtered) expect(Object.keys(FULL_SHARDS)).toContain(s);
    expect(filtered).toEqual(["captions", "seed"]);
    expect(FULL_SHARDS.captions).toEqual(["captions"]);
    expect(FULL_SHARDS.seed).toEqual(["seed-coverage"]);
  });

  test.each([
    "packages/captions/src/model.ts",
    "services/media/src/captions/worker.ts",
    "services/media/src/service.ts",
    "services/origin/src/playlist.ts",
    "services/origin/src/dvr.ts",
    "services/api/src/captions/tracks.ts",
    "apps/web/src/player/captions-toggle.tsx",
    "apps/web/src/routes/_studio/captions.tsx",
    "apps/web/src/i18n/locales/en/w2-captions.json",
    "packages/chat-filter/src/content.ts",
    "infra/containers/whisper.Containerfile",
    "scripts/fetch-model.ts",
    "harness/compose.w2-captions.yaml",
    "harness/scenarios/captions.ts",
    "harness/src/w2/captions/index.ts",
    "harness/fixtures/captions/speech.wav",
    "compose.yaml",
  ])("%s reaches captions", (f) => expect(filteredShardsReached([f])).toContain("captions"));

  test.each([
    "harness/src/seed/money.ts",
    "harness/src/seed/routes.ts",
    "harness/scenarios/seed-coverage.ts",
    "harness/compose.seed.yaml",
    "packages/db/src/schema/users.ts",
    "packages/db/drizzle/0001_protections.sql",
    "apps/web/src/routes/_app/index.tsx",
    "compose.yaml",
  ])("%s reaches seed", (f) => expect(filteredShardsReached([f])).toContain("seed"));

  test.each(["harness/tests/seed/money.test.ts", "services/api/src/routes/playback.ts", "harness/compose.w3.yaml"])(
    "%s does not reach seed",
    (f) => expect(filteredShardsReached([f])).not.toContain("seed"),
  );

  test.each([
    "services/api/src/routes/playback.ts",
    "services/chat/src/core.ts",
    "apps/web/src/player/controller.ts",
    "packages/contracts/src/api/entities.ts",
    "harness/src/w2/splits.ts",
    "harness/compose.w1.yaml",
    "services/media/tests/captions.int.test.ts", // tests never count
    "services/origin/README.md", // nor docs
    "docs/decisions/0011-captions.md",
  ])("%s does not", (f) => expect(filteredShardsReached([f])).toEqual([]));

  test("a push selecting every scenario drops captions unless it reaches captions paths", () => {
    expect(matrixShards({ scenarios: ALL, deploy: false, filteredShards: [] })).toEqual(without);
    expect(matrixShards({ scenarios: ALL, deploy: false, filteredShards: ["captions"] })).toEqual(
      Object.keys(FULL_SHARDS).filter((s) => s !== "seed"),
    );
    expect(matrixShards({ scenarios: ALL, deploy: false, filteredShards: filtered })).toEqual(Object.keys(FULL_SHARDS));
    expect(outputs({ scenarios: ALL, deploy: false, filteredShards: [] })).toContain(
      `shards=${JSON.stringify(without)}\n`,
    );
  });

  test("a narrowed selection keeps the captions shard only when it holds the captions scenario", () => {
    expect(matrixShards({ scenarios: ["captions", "interact"], deploy: false, filteredShards: [] })).toEqual([
      "interact",
      "captions",
    ]);
    expect(matrixShards({ scenarios: ["interact"], deploy: false, filteredShards: ["captions"] })).toEqual([
      "interact",
    ]);
  });

  test("the nightly run, a dispatch and an unreadable diff run captions and seed", () => {
    expect(EVERYTHING.filteredShards).toEqual(filtered);
    expect(matrixShards(EVERYTHING)).toEqual(Object.keys(FULL_SHARDS));
    expect(changesFor({ EVENT_NAME: "schedule", BASE: "a", SHA: "b" }, ROOT).filteredShards).toEqual(filtered);
  });

  test("classify: product code outside the filters selects everything but captions", () => {
    const c = classify(["services/api/src/routes/playback.ts"], GRAPH);
    expect(c).toEqual({ scenarios: ALL, deploy: false, filteredShards: [] });
    expect(matrixShards(c)).toEqual(without);
    expect(classify(["services/media/src/session.ts"], GRAPH).filteredShards).toEqual(["captions"]);
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

  // CI's gate jobs check out one commit (no history): the ranges exist only in a full clone, and
  // without them changesFor falls back to everything, which the cases above already cover.
  const hasHistory = (() => {
    try {
      execFileSync("git", ["cat-file", "-e", "4a29455~1^{commit}"], { cwd: ROOT, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  test.skipIf(!hasHistory)("real ranges in this repository", () => {
    // PROGRESS.md only.
    expect(changesFor({ EVENT_NAME: "push", BASE: "4a29455~1", SHA: "4a29455" }, ROOT)).toEqual({
      scenarios: [],
      deploy: false,
      filteredShards: [],
      docsOnly: true,
    });
    // The consent race fix: harness/src/e9/consent.ts and its unit test.
    expect(changesFor({ EVENT_NAME: "push", BASE: "1c4266f", SHA: "d51c084" }, ROOT)).toEqual({
      scenarios: ["developer-platform"],
      deploy: false,
      filteredShards: [],
    });
  });

  test("classify combines the selection with the deploy check", () => {
    expect(classify(["packages/db/drizzle/0037_x.sql"], GRAPH)).toEqual({
      scenarios: ALL,
      deploy: true,
      filteredShards: ["seed"],
    });
  });
});
