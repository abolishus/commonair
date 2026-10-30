// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { EVERYTHING, changesFor, classify, isDeploy, isDocsOnly } from "../ci-changes.ts";

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

describe("classify", () => {
  test("docs only: neither", () => {
    expect(classify(["PROGRESS.md", ".claude/briefs/batch3/README.md"])).toEqual({ code: false, deploy: false });
  });
  test("app code: the harness, not the deploy jobs", () => {
    expect(classify(["PROGRESS.md", "services/api/src/oauth/tokens.ts"])).toEqual({ code: true, deploy: false });
  });
  test("a migration: both", () => {
    expect(classify(["packages/db/drizzle/0037_x.sql"])).toEqual({ code: true, deploy: true });
  });
});

describe("changesFor", () => {
  test.each([
    { EVENT_NAME: "schedule", BASE: "a", SHA: "b" },
    { EVENT_NAME: "workflow_dispatch" },
    { EVENT_NAME: "push", BASE: "", SHA: "b" },
    { EVENT_NAME: "push", BASE: "0000000000000000000000000000000000000000", SHA: "b" },
    { EVENT_NAME: "push", BASE: "not-a-commit", SHA: "also-not" },
  ])("everything for %o", (env) => expect(changesFor(env)).toEqual(EVERYTHING));

  test("a real range in this repository is classified", () => {
    // The commit that added PROGRESS.md's batch 3 entry touched only PROGRESS.md.
    expect(changesFor({ EVENT_NAME: "push", BASE: "4a29455~1", SHA: "4a29455" })).toEqual({
      code: false,
      deploy: false,
    });
  });
});
