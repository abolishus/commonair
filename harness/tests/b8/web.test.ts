// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** B8-web's harness helpers (`src/b8/web.ts`): the panel link rule, the grace bet, `verify.me`. */
import { describe, expect, it } from "vite-plus/test";
import {
  B8_WEB_IDS,
  GRACE_MS,
  MARKUP_PANEL,
  graceBetProblems,
  panelLinkProblems,
  verifyMeProblems,
} from "../../src/b8/web.ts";

describe("panelLinkProblems", () => {
  it("accepts a new-tab nofollow ugc link, whatever the order", () => {
    expect(panelLinkProblems("_blank", "ugc nofollow noreferrer noopener")).toEqual([]);
  });
  it("names what is missing", () => {
    expect(panelLinkProblems(null, "noopener")).toEqual([
      "target null, want _blank",
      "rel lacks noreferrer",
      "rel lacks nofollow",
      "rel lacks ugc",
    ]);
  });
});

describe("graceBetProblems", () => {
  const lock = { lockMediaTs: "2026-11-03T12:00:00.000Z", lockedAt: "2026-11-03T12:00:01.000Z" };
  const lockedAt = Date.parse(lock.lockedAt);
  it("accepts a bet before the media lock, placed inside the grace", () => {
    expect(
      graceBetProblems(
        { mediaTs: new Date(Date.parse(lock.lockMediaTs) - 1), placedAt: new Date(lockedAt + GRACE_MS - 1) },
        lock,
      ),
    ).toEqual([]);
  });
  it("refuses a missing bet, one at the lock, one before it and one past the grace", () => {
    expect(graceBetProblems(null, lock)).toEqual(["no bet stored"]);
    expect(graceBetProblems({ mediaTs: new Date(lock.lockMediaTs), placedAt: new Date(lockedAt + 1) }, lock)).toEqual([
      "media_ts is not before lock_media_ts",
    ]);
    expect(graceBetProblems({ mediaTs: new Date(0), placedAt: new Date(lockedAt - 1) }, lock)[0]).toMatch(
      /before the lock/,
    );
    expect(graceBetProblems({ mediaTs: new Date(0), placedAt: new Date(lockedAt + GRACE_MS) }, lock)[0]).toMatch(
      /past the grace/,
    );
    expect(graceBetProblems({ mediaTs: null, placedAt: null }, lock)).toHaveLength(2);
  });
});

describe("verifyMeProblems", () => {
  const entries = ["a".repeat(64), "b".repeat(64)];
  it("an entrant sees their own pseudonym, which is in the list", () => {
    expect(verifyMeProblems({ entries, me: { pseudonym: entries[1] as string } }, entries[1] as string)).toEqual([]);
    expect(verifyMeProblems({ entries, me: null }, entries[1] as string)).toHaveLength(1);
    expect(verifyMeProblems({ entries: [], me: { pseudonym: "c" } }, "c")).toEqual([
      "the caller's pseudonym is not in the entries",
    ]);
  });
  it("anyone else sees none, and the salt is never there", () => {
    expect(verifyMeProblems({ entries, me: null }, null)).toEqual([]);
    expect(verifyMeProblems({ entries, me: { pseudonym: "x" } }, null)).toEqual(["a non-entrant got a pseudonym"]);
    expect(verifyMeProblems({ entries, me: null, salt: "00" }, null)).toEqual(["verify publishes the salt"]);
  });
});

describe("the ids and the markup panel", () => {
  it("match docs/testing/b8-selectors.md", () => {
    expect(Object.values(B8_WEB_IDS).sort()).toEqual(
      ["channel-banner", "channel-panel", "channel-panels", "giveaway-verify-mine", "prediction-grace"].sort(),
    );
  });
  it("carries markup the page must show as text, and an http(s) link the API accepts", () => {
    expect(MARKUP_PANEL.body).toMatch(/<b /);
    expect(MARKUP_PANEL.linkUrl).toMatch(/^https:\/\//);
  });
});
