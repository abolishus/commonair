// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The watch-room export's column allow-list (ADR 0017). A change here changes what leaves the
 * platform in a user's archive: the user's own rooms and messages, never another member's id or text.
 */
import { createDb } from "@commonair/db";
import { afterAll, expect, test } from "vite-plus/test";
import { WATCH_ROOM_EXPORT_FILES } from "../src/exports/watch-rooms.ts";

const handle = createDb({ url: "postgres://nobody:nothing@127.0.0.1:9/none", max: 1 });
afterAll(() => handle.close());

const USER = "0190f0f0-0000-7000-8000-00000000aaaa";

test("one account file with two sections and pinned columns", () => {
  expect(WATCH_ROOM_EXPORT_FILES.map((f) => [f.name, f.kind])).toEqual([["watch-rooms.json", "account"]]);
  const file = WATCH_ROOM_EXPORT_FILES[0]!;
  expect(Object.fromEntries(Object.entries(file.sections).map(([n, s]) => [n, Object.keys(s.fields)]))).toEqual({
    rooms: ["roomId", "channelSlug", "hosted", "ageBand", "roomCreatedAt", "roomEndedAt", "joinedAt", "leftAt"],
    messages: ["id", "roomId", "body", "createdAt"],
  });
});

test("every section is bound to the requester and selects no other person", () => {
  for (const section of Object.values(WATCH_ROOM_EXPORT_FILES[0]!.sections)) {
    const q = section.query(handle.db, { userId: USER, channelId: null }).toSQL();
    // Each selected item: a bare column of another person's id or the invite is never one of them
    // (`hosted` compares ids but only the boolean leaves).
    const items = q.sql
      .slice(0, q.sql.search(/ from /i))
      .replace(/^select /i, "")
      .split(", ");
    for (const item of items) expect(item).not.toMatch(/^"[a-z_]+"\."(author_id|user_id|host_id|invite_hash)"$/);
    expect(q.sql).toMatch(/ where /i);
    expect(q.params).toContain(USER);
  }
});
