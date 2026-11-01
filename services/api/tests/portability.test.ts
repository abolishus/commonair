// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The pure parts of `portability.*` (ADR 0037): link state, nonces, the moved-to check, archive keys. */
import { describe, expect, test } from "vite-plus/test";
import { validMovedTo } from "../src/portability/audience.ts";
import { archiveKey, isArchiveKey } from "../src/portability/imports.ts";
import { linkState, moveLinkUrl, newNonce, nonceHash } from "../src/portability/links.ts";

const NOW = new Date("2026-11-01T12:00:00Z");
const CH = "01890000-0000-7000-8000-00000000c001";

describe("linkState", () => {
  test.each([
    [{ revokedAt: null, expiresAt: null }, "active"],
    [{ revokedAt: null, expiresAt: new Date(NOW.getTime() + 1) }, "active"],
    [{ revokedAt: null, expiresAt: NOW }, "expired"],
    [{ revokedAt: null, expiresAt: new Date(NOW.getTime() - 1) }, "expired"],
    [{ revokedAt: NOW, expiresAt: null }, "revoked"],
    // Revoked wins over expired.
    [{ revokedAt: NOW, expiresAt: new Date(NOW.getTime() - 1) }, "revoked"],
  ] as const)("%o → %s", (link, state) => {
    expect(linkState(link, NOW)).toBe(state);
  });
});

describe("nonces", () => {
  test("128 bits, base64url, never repeated; stored as hex SHA-256", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const n = newNonce();
      expect(n).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(Buffer.from(n, "base64url")).toHaveLength(16);
      seen.add(n);
    }
    expect(seen.size).toBe(200);
    expect(await nonceHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("the landing URL", () => {
    expect(moveLinkUrl("https://tv.example/", "ada", "N0nce")).toBe("https://tv.example/m/ada/N0nce");
  });
});

describe("validMovedTo", () => {
  test.each([
    ["https://video.example.org/c/ada", "https://video.example.org/c/ada"],
    ["https://Video.Example.org", "https://video.example.org/"],
    ["http://video.example.org", null],
    ["https://u:p@video.example.org", null],
    ["https://u@video.example.org", null],
    ["javascript:alert(1)", null],
    ["not a url", null],
    [`https://e.org/${"a".repeat(500)}`, null],
  ])("%s", (raw, out) => {
    expect(validMovedTo(raw)).toBe(out);
  });
});

describe("archive keys", () => {
  test("only the channel's own incoming/portability zip keys", () => {
    const key = archiveKey(CH, "01890000-0000-7000-8000-0000000000aa");
    expect(key).toBe(`incoming/portability/${CH}/01890000-0000-7000-8000-0000000000aa.zip`);
    expect(isArchiveKey(key, CH)).toBe(true);
    expect(isArchiveKey(key, "01890000-0000-7000-8000-00000000c002")).toBe(false);
    expect(isArchiveKey(`${key}/../x.zip`, CH)).toBe(false);
    expect(isArchiveKey(key.replace(".zip", ".png"), CH)).toBe(false);
    expect(isArchiveKey(key.replace("incoming/", ""), CH)).toBe(false);
  });
});
