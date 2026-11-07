// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The verdict diagnostics against a migrated database: the query the viewers and integrity-basic
 * scenarios run when a count does not converge, on Bun.SQL as they run it.
 */
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { readSessionVerdicts, sessionVerdicts } from "../src/session-verdicts.ts";

let t: TestDatabase;
const owner = uuidv7();
const channel = uuidv7();
const excluded = uuidv7();
const verified = uuidv7();
const startedAt = new Date(Date.now() - 120_000);

beforeAll(async () => {
  t = await createTestDatabase();
  await t.db.insert(schema.users).values({
    id: owner,
    name: "verdicts owner",
    email: "verdicts-owner@example.test",
    username: "verdicts_owner",
    birthDate: "1990-01-01",
  });
  await t.db.insert(schema.channels).values({ id: channel, ownerId: owner, slug: "verdicts", displayName: "v" });
  const session = { channelId: channel, deviceHash: "d", ipHash: "i", startedAt, heartbeats: 13, watchSeconds: 118 };
  await t.db.insert(schema.playbackSessions).values([
    { ...session, id: excluded, verdict: "excluded", verdictReasons: ["fetch_pattern", "headless"], score: 0.92 },
    { ...session, id: verified, verdict: "verified", segmentsFetched: 60 },
  ]);
  // Raised 3.6 s into the session, as in main CI run 41812379909.
  const flaggedAt = new Date(startedAt.getTime() + 3_600);
  await t.db.insert(schema.integrityFlags).values([
    {
      subjectType: "session",
      subjectId: excluded,
      channelId: channel,
      signal: "fetch_pattern",
      score: 0.8,
      details: { checks: ["playlists_without_segments"], playlists: 12, segments: 0 },
      createdAt: flaggedAt,
    },
    {
      subjectType: "session",
      subjectId: excluded,
      channelId: channel,
      signal: "headless",
      score: 0.6,
      createdAt: new Date(flaggedAt.getTime() + 50_000),
    },
  ]);
});

afterAll(async () => {
  await t?.drop();
});

describe("readSessionVerdicts", () => {
  test("reads verdicts, counters and each flag's time into the session, oldest first", async () => {
    const rows = await readSessionVerdicts(t.url, [excluded, verified]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ex = byId.get(excluded);
    expect(ex).toMatchObject({
      verdict: "excluded",
      reasons: ["fetch_pattern", "headless"],
      score: 0.92,
      source: "origin",
      heartbeats: 13,
      watch_seconds: 118,
      ended: false,
    });
    expect(ex?.flags.map((f) => [f.signal, f.after_s])).toEqual([
      ["fetch_pattern", 3.6],
      ["headless", 53.6],
    ]);
    expect(ex?.flags[0]?.details).toEqual({ checks: ["playlists_without_segments"], playlists: 12, segments: 0 });
    expect(ex?.age_s).toBeGreaterThanOrEqual(119);
    expect(byId.get(verified)).toMatchObject({ verdict: "verified", segments_fetched: 60, flags: [] });
  });

  test("no ids reads nothing", async () => {
    expect(await readSessionVerdicts(t.url, [])).toEqual([]);
  });

  test("sessionVerdicts names the start-up exclusion", async () => {
    const r = await sessionVerdicts(t.url, [
      { label: "0", kind: "browser", sessionId: excluded },
      { label: "1", kind: "http", sessionId: verified },
      { label: "2", kind: "http", sessionId: null },
    ]);
    expect(r.verdicts).toEqual(["0:browser:excluded", "1:http:verified", "2:http:no session"]);
    expect(r.flaggedAtStartup).toEqual([{ viewer: "0", id: excluded, afterS: 3.6, signals: ["fetch_pattern"] }]);
  });
});
