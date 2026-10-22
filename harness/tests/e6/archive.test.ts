// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Reading export archives and scanning them for other people's data and secrets. */
import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vite-plus/test";
import {
  ArchiveError,
  MIN_NEEDLE_LENGTH,
  SECRET_PATTERNS,
  checkManifest,
  containsValue,
  jsonEntry,
  manifestOk,
  parseManifest,
  readZip,
  rowCount,
  scanFiles,
  valueNeedles,
} from "../../src/e6/archive.ts";

const json = (v: unknown) => strToU8(JSON.stringify(v));

function archive(files: Record<string, unknown>, manifestFiles?: { name: string; rows: number }[]): Uint8Array {
  const listed =
    manifestFiles ?? Object.entries(files).map(([name, v]) => ({ name, rows: Array.isArray(v) ? v.length : 1 }));
  const manifest = {
    formatVersion: 1,
    kind: "account",
    exportId: "e1",
    userId: "u1",
    generatedAt: "2026-10-22T00:00:00.000Z",
    files: listed,
  };
  const entries: Record<string, Uint8Array> = { "manifest.json": json(manifest) };
  for (const [name, v] of Object.entries(files)) entries[name] = json(v);
  return zipSync(entries);
}

describe("readZip and the manifest", () => {
  test("reads every file and parses the manifest", () => {
    const files = readZip(archive({ "account.json": { id: "u1" }, "chat.json": [{ body: "hi" }, { body: "yo" }] }));
    expect([...files.keys()].sort()).toEqual(["account.json", "chat.json", "manifest.json"]);
    const m = parseManifest(jsonEntry(files, "manifest.json"));
    expect(m.userId).toBe("u1");
    const c = checkManifest(files, m);
    expect(c).toEqual({ unlisted: [], missing: [], rowMismatches: [] });
    expect(manifestOk(c)).toBe(true);
  });

  test("an empty zip is still a zip", () => {
    expect(readZip(zipSync({})).size).toBe(0);
  });

  test("directories are dropped", () => {
    const files = readZip(zipSync({ "dir/": new Uint8Array(), "dir/a.json": json([]) }));
    expect([...files.keys()]).toEqual(["dir/a.json"]);
  });

  test("unlisted, missing and miscounted files are reported", () => {
    const bytes = archive({ "a.json": [1, 2, 3], "b.json": { x: 1 } }, [
      { name: "a.json", rows: 2 },
      { name: "c.json", rows: 0 },
    ]);
    const files = readZip(bytes);
    const c = checkManifest(files, parseManifest(jsonEntry(files, "manifest.json")));
    expect(c.unlisted).toEqual(["b.json"]);
    expect(c.missing).toEqual(["c.json"]);
    expect(c.rowMismatches).toEqual([{ name: "a.json", listed: 2, actual: 3 }]);
    expect(manifestOk(c)).toBe(false);
  });

  test("rowCount: arrays by length, objects as one", () => {
    expect(rowCount([])).toBe(0);
    expect(rowCount([1, 2])).toBe(2);
    expect(rowCount({ a: 1 })).toBe(1);
  });

  test("anything but a zip is refused", () => {
    expect(() => readZip(strToU8("<Error>AccessDenied</Error>"))).toThrow(ArchiveError);
    expect(() => readZip(new Uint8Array())).toThrow(ArchiveError);
    expect(() => readZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toThrow(ArchiveError);
  });

  test("a missing or malformed entry is an ArchiveError", () => {
    const files = readZip(zipSync({ "x.json": strToU8("{nope") }));
    expect(() => jsonEntry(files, "x.json")).toThrow(/not JSON/);
    expect(() => jsonEntry(files, "y.json")).toThrow(/missing/);
    expect(() => parseManifest({ formatVersion: 1 })).toThrow(ArchiveError);
    expect(() => parseManifest(null)).toThrow(ArchiveError);
  });
});

describe("scanFiles", () => {
  const files = readZip(
    zipSync({
      "follows.json": json([{ channelSlug: "e6dx_s_abc1" }]),
      "chat.json": json([{ body: "e6dx uchat run1" }, { body: "hello Vother run1" }]),
      "tips.json": json([{ message: "e6dx utip run1", email: "V.Person@Harness.test" }]),
    }),
  );

  test("finds exact values and reports labels per file, never the value", () => {
    const hits = scanFiles(files, [
      ...valueNeedles("v.displayName", ["Vother run1"]),
      ...valueNeedles("v.email", ["v.person@harness.test"], true),
      ...valueNeedles("v.id", ["0198a1b2-0000-7000-8000-000000000001"]),
    ]);
    expect(hits).toEqual([
      { file: "chat.json", label: "v.displayName" },
      { file: "tips.json", label: "v.email" },
    ]);
    expect(JSON.stringify(hits)).not.toContain("harness.test");
  });

  test("case-sensitive needles miss a different case", () => {
    expect(scanFiles(files, valueNeedles("x", ["VOTHER RUN1"]))).toEqual([]);
    expect(scanFiles(files, valueNeedles("x", ["VOTHER RUN1"], true))).toHaveLength(1);
  });

  test("one hit per label and file even with several matching needles", () => {
    const hits = scanFiles(files, [
      ...valueNeedles("run", ["e6dx uchat run1"]),
      ...valueNeedles("run", ["Vother run1"]),
    ]);
    expect(hits).toEqual([{ file: "chat.json", label: "run" }]);
  });

  test("valueNeedles drops empty, short and duplicate values", () => {
    const n = valueNeedles("x", [
      "",
      null,
      undefined,
      "abc",
      "a".repeat(MIN_NEEDLE_LENGTH),
      "a".repeat(MIN_NEEDLE_LENGTH),
    ]);
    expect(n).toHaveLength(1);
    expect(valueNeedles("x", ["Abcdefg", "abcdefg"], true)).toHaveLength(1);
    expect(valueNeedles("x", ["Abcdefg", "abcdefg"])).toHaveLength(2);
  });

  test("secret shapes: scrypt, bcrypt and argon2 hashes, private keys", () => {
    const scrypt = `${"a1".repeat(16)}:${"b2".repeat(64)}`;
    const bcrypt = `$2b$10$${"A".repeat(53)}`;
    const secretFiles = readZip(
      zipSync({
        "a.json": json({ h: scrypt }),
        "b.json": json({ h: bcrypt }),
        "c.json": json({ h: "$argon2id$v=19$m=65536,t=3,p=4$abc$def" }),
        "d.json": json({ k: "-----BEGIN PRIVATE KEY-----" }),
        "ok.json": json({ id: "0198a1b2-0000-7000-8000-000000000001", n: "deadbeef".repeat(4) }),
      }),
    );
    expect(scanFiles(secretFiles, SECRET_PATTERNS)).toEqual([
      { file: "a.json", label: "password-hash:scrypt" },
      { file: "b.json", label: "password-hash:bcrypt" },
      { file: "c.json", label: "password-hash:argon2" },
      { file: "d.json", label: "private-key" },
    ]);
  });

  test("containsValue, optionally limited to some files", () => {
    expect(containsValue(files, "e6dx_s_abc1")).toBe(true);
    expect(containsValue(files, "e6dx_s_abc1", (n) => n === "follows.json")).toBe(true);
    expect(containsValue(files, "e6dx_s_abc1", (n) => n === "chat.json")).toBe(false);
    expect(containsValue(files, "absent value")).toBe(false);
  });
});
