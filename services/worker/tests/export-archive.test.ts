// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EXPORT_FORMAT_VERSION } from "@commonair/contracts/internal";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, test } from "vite-plus/test";
import { buildArchive, countRows, MANIFEST } from "../src/exports/archive.ts";

const generatedAt = new Date("2026-10-22T12:00:00.000Z");

describe("export archive", () => {
  test("zips one JSON file per entry plus a manifest with row counts", () => {
    const files = new Map<string, unknown>([
      ["account.json", { id: "u1", createdAt: new Date("2026-01-02T03:04:05.000Z") }],
      ["follows.json", [{ channelSlug: "a" }, { channelSlug: "b" }]],
      ["chat.json", []],
      ["coop.json", { memberships: [{}], votes: [{}, {}], shares: [] }],
      ["channel.json", { settings: { slug: "s" }, panels: [{}, {}, {}] }],
    ]);
    const { bytes, manifest } = buildArchive({ kind: "account", exportId: "e1", userId: "u1", generatedAt, files });
    const unzipped = unzipSync(bytes);
    expect(Object.keys(unzipped).sort()).toEqual(
      ["account.json", "channel.json", "chat.json", "coop.json", "follows.json", MANIFEST].sort(),
    );
    const read = (n: string) => JSON.parse(strFromU8(unzipped[n] ?? new Uint8Array())) as unknown;
    expect(read(MANIFEST)).toEqual({
      formatVersion: EXPORT_FORMAT_VERSION,
      kind: "account",
      exportId: "e1",
      userId: "u1",
      generatedAt: "2026-10-22T12:00:00.000Z",
      files: [
        { name: "account.json", rows: 1 },
        { name: "follows.json", rows: 2 },
        { name: "chat.json", rows: 0 },
        { name: "coop.json", rows: 3 },
        { name: "channel.json", rows: 4 },
      ],
    });
    expect(manifest.files).toHaveLength(5);
    // Timestamps are ISO 8601 UTC.
    expect(read("account.json")).toEqual({ id: "u1", createdAt: "2026-01-02T03:04:05.000Z" });
    expect(read("follows.json")).toEqual([{ channelSlug: "a" }, { channelSlug: "b" }]);
  });

  test("an empty export still has its manifest", () => {
    const { bytes, manifest } = buildArchive({
      kind: "channel",
      exportId: "e2",
      userId: "u2",
      generatedAt,
      files: new Map(),
    });
    expect(Object.keys(unzipSync(bytes))).toEqual([MANIFEST]);
    expect(manifest).toMatchObject({ kind: "channel", files: [] });
  });

  test("refuses an entry that would overwrite the manifest", () => {
    expect(() =>
      buildArchive({ kind: "account", exportId: "e", userId: "u", generatedAt, files: new Map([[MANIFEST, {}]]) }),
    ).toThrow(/duplicate/);
  });

  test("row counts", () => {
    expect(countRows(null)).toBe(0);
    expect(countRows(undefined)).toBe(0);
    expect(countRows([])).toBe(0);
    expect(countRows([1, 2, 3])).toBe(3);
    expect(countRows({ a: 1 })).toBe(1);
    expect(countRows({ a: [], b: [] })).toBe(0);
    expect(countRows({ a: [1], b: [2, 3] })).toBe(3);
    expect(countRows({ settings: null, a: [1] })).toBe(1);
    expect(countRows({ settings: { x: 1 }, a: [1] })).toBe(2);
  });
});
