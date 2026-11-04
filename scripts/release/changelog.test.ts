// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// --since-tag and --check (R0-release-prep, U3's two-week cadence). The notes themselves are
// covered by scripts/tests/release-changelog.test.ts.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import {
  changelogSectionProblem,
  compareVersions,
  hasChangelogSection,
  isPrerelease,
  newestReleaseTag,
  parseVersion,
} from "./changelog.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("compareVersions", () => {
  test("semver precedence, prereleases below their release", () => {
    const sorted = [
      "v0.1.0",
      "v0.1.0-rc.10",
      "v0.1.0-rc.2",
      "v0.1.0-rc.1",
      "v1.0.0",
      "v0.2.0",
      "v0.1.1",
      "v0.10.0",
      "v0.1.0-alpha",
      "v0.1.0-alpha.1",
      "v0.1.0-beta",
    ].sort(compareVersions);
    expect(sorted).toEqual([
      "v0.1.0-alpha",
      "v0.1.0-alpha.1",
      "v0.1.0-beta",
      "v0.1.0-rc.1",
      "v0.1.0-rc.2",
      "v0.1.0-rc.10",
      "v0.1.0",
      "v0.1.1",
      "v0.2.0",
      "v0.10.0",
      "v1.0.0",
    ]);
  });

  test("numeric identifiers rank below alphanumeric ones; equal versions are 0", () => {
    expect(compareVersions("1.0.0-1", "1.0.0-a")).toBeLessThan(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  test("refuses what is not a version", () => {
    expect(() => compareVersions("v1.2", "v1.2.0")).toThrow("not a version: v1.2");
    expect(parseVersion("v01.2.3")).toBeNull();
    expect(parseVersion("v1.2.3+build")).toBeNull();
  });

  test("isPrerelease", () => {
    expect(isPrerelease("v0.1.0-rc.2")).toBe(true);
    expect(isPrerelease("v0.1.0")).toBe(false);
    expect(isPrerelease("nightly")).toBe(false);
  });
});

describe("--since-tag's default", () => {
  const tags = ["v0.1.0-rc.1", "v0.1.0-rc.2", "v0.1.0", "v0.2.0-rc.1", "v0.2.0", "v0.2.1", "v0.3.0-rc.1"];

  test("the newest release, never a prerelease", () => {
    expect(newestReleaseTag(tags)).toBe("v0.2.1");
  });

  test("leaves out the tag being released and tags on --to", () => {
    expect(newestReleaseTag(tags, ["v0.2.1"])).toBe("v0.2.0");
    expect(newestReleaseTag(tags, ["v0.2.1", "v0.2.0"])).toBe("v0.1.0");
  });

  test("by precedence, not by the order git lists tags in", () => {
    expect(newestReleaseTag(["v0.10.0", "v0.9.0", "v0.2.0"])).toBe("v0.10.0");
  });

  test("none before the first release: only release candidates (v0.1.0's case)", () => {
    expect(newestReleaseTag(["v0.1.0-rc.1", "v0.1.0-rc.9"], ["v0.1.0"])).toBeNull();
    expect(newestReleaseTag([])).toBeNull();
  });

  test("ignores tags that are not versions", () => {
    expect(newestReleaseTag(["latest", "v1", "release-1.0.0", "v0.1.0"])).toBe("v0.1.0");
  });
});

describe("--check", () => {
  const md = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "## [0.1.0] - unreleased",
    "",
    "## [0.1.0-rc.2] - 2026-10-26",
    "",
    "[0.1.0-rc.2]: https://example.org",
  ].join("\n");

  test("a dated or undated section heading counts", () => {
    expect(hasChangelogSection(md, "0.1.0")).toBe(true);
    expect(hasChangelogSection(md, "v0.1.0-rc.2")).toBe(true);
    expect(hasChangelogSection("## [0.2.0]\n", "0.2.0")).toBe(true);
  });

  test("a link reference, a prefix or another version does not", () => {
    expect(hasChangelogSection(md, "0.1.0-rc.1")).toBe(false);
    expect(hasChangelogSection(md, "0.1")).toBe(false);
    expect(hasChangelogSection("[0.2.0]: https://example.org\n### [0.2.0]\n", "0.2.0")).toBe(false);
    expect(hasChangelogSection("## [0.2.0]x\n", "0.2.0")).toBe(false);
  });

  const run = (args: string[]) =>
    Bun.spawnSync([process.execPath, "scripts/release/changelog.ts", ...args], { cwd: ROOT });

  test("a release needs its section dated; a prerelease needs only the section", () => {
    expect(changelogSectionProblem(md, "0.1.0")).toContain("section 0.1.0 is not dated");
    expect(changelogSectionProblem("## [0.1.0]\n", "v0.1.0")).toContain("is not dated");
    expect(changelogSectionProblem("## [0.1.0] - 2026-11-16\n", "v0.1.0")).toBeNull();
    expect(changelogSectionProblem("## [0.1.0] - 2026-11\n", "0.1.0")).toContain("is not dated");
    expect(changelogSectionProblem("## [0.1.0] - unreleased\n## [0.1.0] - 2026-11-16\n", "0.1.0")).toBeNull();
    expect(changelogSectionProblem("## [0.10.0] - 2026-11-16\n## [0.1.0]\n", "0.1.0")).toContain("is not dated");
    expect(changelogSectionProblem(md, "0.1.0-rc.2")).toBeNull();
    expect(changelogSectionProblem("## [0.2.0-rc.1] - unreleased\n", "v0.2.0-rc.1")).toBeNull();
    expect(changelogSectionProblem(md, "0.3.0")).toContain("has no section for 0.3.0");
  });

  test("the repository's own CHANGELOG.md has the 0.1.0 section (dated when 0.1.0 is tagged)", () => {
    expect(hasChangelogSection(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), "0.1.0")).toBe(true);
  });

  test("the CLI passes a dated release and refuses one still marked unreleased", () => {
    const dir = mkdtempSync(join(tmpdir(), "changelog-check-"));
    const file = join(dir, "CHANGELOG.md");
    writeFileSync(file, md);
    const undated = run(["--version", "0.1.0", "--check", "--changelog", file]);
    expect(undated.exitCode).toBe(1);
    expect(undated.stderr.toString()).toContain('change its heading to "## [0.1.0] - <YYYY-MM-DD>"');
    writeFileSync(file, md.replace("## [0.1.0] - unreleased", "## [0.1.0] - 2026-11-16"));
    const dated = run(["--version", "v0.1.0", "--check", "--changelog", file]);
    expect(dated.stderr.toString()).toBe("");
    expect(dated.exitCode).toBe(0);
  });

  test("the CLI fails, naming the heading to add, when the section is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "changelog-check-"));
    const file = join(dir, "CHANGELOG.md");
    writeFileSync(file, md);
    const r = run(["--version", "v0.3.0", "--check", "--changelog", file]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('add "## [0.3.0] - <YYYY-MM-DD>"');
  });

  test("CHANGELOG.md keeps the rc sections short: each points at its tag", () => {
    const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    for (const rc of ["0.1.0-rc.1", "0.1.0-rc.2"]) {
      expect(hasChangelogSection(changelog, rc)).toBe(true);
      expect(changelog).toContain(`[${rc}]: https://github.com/abolishus/commonair/releases/tag/v${rc}`);
    }
  });
});
