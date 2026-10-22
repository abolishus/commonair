// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { type Commit, GIT_LOG_FORMAT, parseCommit, parseGitLog, releaseNotes } from "../release/changelog.ts";

let n = 0;
const c = (subject: string, body = ""): Commit => ({ sha: (++n).toString(16).padStart(40, "0"), subject, body });
const notes = (commits: Commit[]) => releaseNotes(commits, { version: "0.2.0", previousTag: "v0.1.0" });
const headings = (md: string) => md.split("\n").filter((l) => l.startsWith("### "));

describe("parseCommit", () => {
  test("type, scope and description", () => {
    expect(parseCommit(c("feat(web): add a player"))).toMatchObject({
      type: "feat",
      scope: "web",
      description: "add a player",
      breaking: false,
    });
  });

  test("a scope with a comma keeps it whole", () => {
    expect(parseCommit(c("feat(media,origin): AAC copy")).scope).toBe("media,origin");
  });

  test.each(["Update README", "feat:no space", "Feat: capitalised", "feat(): empty scope", "WIP"])(
    "%j is not conventional",
    (subject) => expect(parseCommit(c(subject)).type).toBeNull(),
  );

  test("breaking by !", () => {
    expect(parseCommit(c("refactor(api)!: drop v1 routes")).breaking).toBe(true);
  });

  test("breaking by footer, either spelling", () => {
    const a = parseCommit(c("feat: new config", "Body.\n\nBREAKING CHANGE: TLS_MODE is required"));
    expect(a).toMatchObject({ breaking: true, breakingNote: "TLS_MODE is required" });
    expect(parseCommit(c("fix: x", "BREAKING-CHANGE: y")).breaking).toBe(true);
  });
});

describe("releaseNotes", () => {
  test("groups in the documented order, breaking changes first", () => {
    const md = notes([
      c("chore: tidy"),
      c("test: more cases"),
      c("fix(chat): reconnect"),
      c("feat(web): player"),
      c("docs: guide"),
      c("perf: faster"),
      c("ci: cache"),
      c("build: pin"),
      c("refactor: split"),
      c("feat(api)!: remove legacy"),
    ]);
    expect(headings(md)).toEqual([
      "### Breaking changes",
      "### Features",
      "### Fixes",
      "### Performance",
      "### Refactoring",
      "### Documentation",
      "### Build",
      "### CI",
      "### Tests",
      "### Chores",
    ]);
    // The breaking commit is listed under its type too, so the type section stays complete.
    const breaking = md.slice(md.indexOf("### Breaking"), md.indexOf("### Features"));
    expect(breaking).toContain("**api:** remove legacy");
  });

  test("keeps the scope and links commits when a repo URL is given", () => {
    const commit = c("fix(relay): retry receipts");
    const md = releaseNotes([commit], { version: "1.0.0", previousTag: null, repoUrl: "https://example.org/x/y" });
    expect(md).toContain(
      `- **relay:** retry receipts ([${commit.sha.slice(0, 7)}](https://example.org/x/y/commit/${commit.sha}))`,
    );
    expect(md).toContain("since the first commit");
  });

  test("the footer text follows the breaking entry", () => {
    const md = notes([c("feat: env", "BREAKING CHANGE: set PUBLIC_HOSTNAME")]);
    expect(md).toMatch(/### Breaking changes\n\n- env \([0-9a-f]{7}\)\n {2}set PUBLIC_HOSTNAME/);
  });

  test("non-conventional subjects and unknown types go under Other", () => {
    const md = notes([c("Initial import"), c("style: whitespace"), c("feat: x")]);
    expect(headings(md)).toEqual(["### Features", "### Other"]);
    const other = md.slice(md.indexOf("### Other"));
    expect(other).toContain("- Initial import");
    expect(other).toContain("- style: whitespace");
  });

  test("an empty range", () => {
    const md = notes([]);
    expect(headings(md)).toEqual([]);
    expect(md).toContain("No changes.");
    expect(md).toContain("since v0.1.0");
  });

  test("DCO and Co-Authored-By trailers never reach the notes", () => {
    const md = notes([
      c(
        "feat(ci): release workflow",
        "Adds release.yml.\n\nSigned-off-by: Someone <someone@example.org>\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
      ),
    ]);
    expect(md).not.toMatch(/Signed-off-by|Co-Authored-By|example\.org|anthropic/);
    expect(md).not.toContain("Adds release.yml");
    expect(headings(md)).toEqual(["### Features"]);
  });
});

describe("parseGitLog", () => {
  test("splits records and fields of the format the CLI asks git for", () => {
    expect(GIT_LOG_FORMAT).toBe("%H\x1f%s\x1f%b\x1e");
    const raw = `${"a".repeat(40)}\x1ffeat: one\x1fbody line\n\nSigned-off-by: X <x@y>\n\x1e\n${"b".repeat(40)}\x1ffix: two\x1f\x1e\n`;
    expect(parseGitLog(raw)).toEqual([
      { sha: "a".repeat(40), subject: "feat: one", body: "body line\n\nSigned-off-by: X <x@y>" },
      { sha: "b".repeat(40), subject: "fix: two", body: "" },
    ]);
    expect(parseGitLog("")).toEqual([]);
  });
});
