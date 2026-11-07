// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { STARTUP_SECONDS, type SessionVerdictRow, isStartupFlag, verdictReport } from "../src/session-verdicts.ts";

function row(id: string, verdict: string, flags: SessionVerdictRow["flags"] = []): SessionVerdictRow {
  return {
    id,
    verdict,
    reasons: flags.map((f) => f.signal),
    score: flags.length > 0 ? 0.92 : 0,
    source: "origin",
    heartbeats: 13,
    watch_seconds: 118,
    segments_fetched: 128,
    bytes_http: 81_078_441,
    bytes_p2p: 0,
    ended: false,
    age_s: 130,
    flags,
  };
}

/** Main CI run 41812379909: viewer 0 excluded 3.6 s in, on playlists polled before any segment. */
const startupExclusion = row("s0", "excluded", [
  {
    signal: "fetch_pattern",
    score: 0.8,
    details: { checks: ["playlists_without_segments"], segments: 0, playlists: 12, expectedSegments: 0 },
    after_s: 3.6,
  },
  { signal: "headless", score: 0.6, details: { flags: ["headless_user_agent"] }, after_s: 3.6 },
]);

describe("verdictReport", () => {
  test("names an honest session excluded at start-up, with the signals raised then", () => {
    const r = verdictReport(
      [
        { label: "0", kind: "browser", sessionId: "s0" },
        { label: "1", kind: "http", sessionId: "s1" },
      ],
      [startupExclusion, row("s1", "verified")],
    );
    expect(r.verdicts).toEqual(["0:browser:excluded", "1:http:verified"]);
    expect(r.unexpected.map((s) => s.viewer)).toEqual(["0"]);
    expect(r.flaggedAtStartup).toEqual([
      { viewer: "0", id: "s0", afterS: 3.6, signals: ["fetch_pattern", "headless"] },
    ]);
  });

  test("a session flagged after start-up is unexpected but not a start-up flag", () => {
    const late = row("s0", "excluded", [{ signal: "heartbeat_timing", score: 0.8, details: {}, after_s: 45 }]);
    const r = verdictReport([{ label: "a", kind: "http", sessionId: "s0" }], [late]);
    expect(r.unexpected).toHaveLength(1);
    expect(r.flaggedAtStartup).toEqual([]);
  });

  test("the start-up bound is inclusive and only the earliest flags within it are listed", () => {
    const r = verdictReport(
      [{ label: "a", kind: "http", sessionId: "s0" }],
      [
        row("s0", "excluded", [
          { signal: "fetch_pattern", score: 0.8, details: {}, after_s: STARTUP_SECONDS },
          { signal: "headless", score: 0.6, details: {}, after_s: STARTUP_SECONDS + 0.1 },
        ]),
      ],
    );
    expect(r.flaggedAtStartup).toEqual([
      { viewer: "a", id: "s0", afterS: STARTUP_SECONDS, signals: ["fetch_pattern"] },
    ]);
  });

  test("a flag after the clock bound still counts when nothing was expected yet", () => {
    // A player whose first heartbeat is late: judged 14 s in, before any watch time was credited.
    const slow = row("s0", "excluded", [
      {
        signal: "fetch_pattern",
        score: 0.8,
        details: { checks: ["playlists_without_segments"], segments: 0, playlists: 30, expectedSegments: 0 },
        after_s: 14,
      },
      { signal: "headless", score: 0.6, details: {}, after_s: 14 },
    ]);
    const r = verdictReport([{ label: "a", kind: "browser", sessionId: "s0" }], [slow]);
    expect(r.flaggedAtStartup).toEqual([{ viewer: "a", id: "s0", afterS: 14, signals: ["fetch_pattern"] }]);
  });

  test("a flag with no time but nothing expected is start-up, with no time reported", () => {
    const r = verdictReport(
      [{ label: "a", kind: "http", sessionId: "s0" }],
      [
        row("s0", "excluded", [
          { signal: "fetch_pattern", score: 0.8, details: { expectedSegments: 0 }, after_s: null },
        ]),
      ],
    );
    expect(r.flaggedAtStartup).toEqual([{ viewer: "a", id: "s0", afterS: null, signals: ["fetch_pattern"] }]);
  });

  test("isStartupFlag: the clock bound, the scorer's measure, and neither", () => {
    const flag = (after_s: number | null, details: Record<string, unknown> = {}) => ({
      signal: "fetch_pattern",
      score: 0.8,
      details,
      after_s,
    });
    expect(isStartupFlag(flag(0))).toBe(true);
    expect(isStartupFlag(flag(STARTUP_SECONDS))).toBe(true);
    expect(isStartupFlag(flag(STARTUP_SECONDS + 0.1))).toBe(false);
    expect(isStartupFlag(flag(60, { expectedSegments: 0 }))).toBe(true);
    expect(isStartupFlag(flag(60, { expectedSegments: 3 }))).toBe(false);
    expect(isStartupFlag(flag(null))).toBe(false);
    expect(isStartupFlag(flag(5), 2)).toBe(false);
  });

  test("a viewer without a session, a session missing from Postgres and a flag without a time", () => {
    const r = verdictReport(
      [
        { label: "a", kind: "browser", sessionId: null },
        { label: "b", kind: "http", sessionId: "gone" },
        { label: "c", kind: "http", sessionId: "s2" },
      ],
      [row("s2", "pending", [{ signal: "fetch_pattern", score: 0.4, details: {}, after_s: null }])],
    );
    expect(r.verdicts).toEqual(["a:browser:no session", "b:http:missing", "c:http:pending"]);
    expect(r.unexpected.map((s) => s.viewer)).toEqual(["a", "b", "c"]);
    expect(r.flaggedAtStartup).toEqual([]);
  });

  test("bots are judged against excluded", () => {
    const r = verdictReport(
      [
        { label: "bot-0", kind: "bot", sessionId: "s0" },
        { label: "bot-1", kind: "bot", sessionId: "s1" },
      ],
      [startupExclusion, row("s1", "verified")],
      "excluded",
    );
    expect(r.unexpected.map((s) => s.viewer)).toEqual(["bot-1"]);
    expect(r.flaggedAtStartup).toEqual([]);
  });

  test("no viewers, no rows", () => {
    expect(verdictReport([], [])).toEqual({ sessions: [], unexpected: [], verdicts: [], flaggedAtStartup: [] });
  });
});
