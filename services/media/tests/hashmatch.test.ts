// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { createHashMatcher, NoopHashMatcher, parseHashList, StubVendorMatcher } from "../src/safety/hashmatch.ts";

const ctx = { subjectType: "broadcast" as const, subjectId: crypto.randomUUID(), channelId: crypto.randomUUID() };
const bytes = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

const dir = mkdtempSync(join(tmpdir(), "hashlist-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("hash matchers", () => {
  test("the no-op matcher never matches and is not recorded", async () => {
    const m = new NoopHashMatcher();
    expect(m.records).toBe(false);
    expect(await m.check()).toEqual({ matched: false, details: {} });
  });

  test("the stub matches exactly the listed SHA-256 digests", async () => {
    const listed = bytes("listed image bytes");
    const m = new StubVendorMatcher(new Set([sha(listed)]));
    expect((await m.check(listed)).matched).toBe(true);
    expect((await m.check(bytes("listed image bytes!"))).matched).toBe(false);
    expect((await m.check(new Uint8Array())).matched).toBe(false);
  });

  test("details never contain the image digest", async () => {
    const img = bytes("some frame");
    const m = new StubVendorMatcher(new Set([sha(img)]));
    const r = await m.check(img);
    expect(JSON.stringify(r.details)).not.toContain(sha(img));
    expect(r.details).toEqual({ method: "sha256-list", listSize: 1 });
  });

  test("list files: comments, blank lines, case-insensitive hex", () => {
    const a = sha(bytes("a"));
    const set = parseHashList(`# operator list\n\n${a.toUpperCase()}  # first\n${sha(bytes("b"))}\n`);
    expect(set).toEqual(new Set([a, sha(bytes("b"))]));
  });

  test("a malformed list entry is rejected loudly", () => {
    expect(() => parseHashList("not-a-hash\n")).toThrow(/SHA-256/);
    expect(() => parseHashList(`${"a".repeat(63)}\n`)).toThrow(/SHA-256/);
  });

  test("createHashMatcher follows HASH_MATCH_PROVIDER", async () => {
    expect(createHashMatcher({ HASH_MATCH_PROVIDER: "none" }).name).toBe("none");
    expect(() => createHashMatcher({ HASH_MATCH_PROVIDER: "stub" })).toThrow(/HASH_MATCH_LIST_FILE/);
    const img = bytes("harness frame");
    const file = join(dir, "list.txt");
    writeFileSync(file, `${sha(img)}\n`);
    const m = createHashMatcher({ HASH_MATCH_PROVIDER: "stub", HASH_MATCH_LIST_FILE: file });
    expect(m.name).toBe("stub");
    expect((await m.check(img, ctx)).matched).toBe(true);
  });
});
