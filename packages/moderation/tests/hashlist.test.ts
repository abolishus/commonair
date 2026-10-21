// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from "vite-plus/test";
import { HASH_LIST_CATEGORIES } from "@commonair/contracts/enums";
import { createHashMatcher, HashListParseError, parseHashList, staticHashList } from "../src/hashlist.ts";

const csam = HASH_LIST_CATEGORIES[0]!;
const ncii = HASH_LIST_CATEGORIES.find((x) => x !== csam)!;
const zero = "0".repeat(64);
const bits = (n: number) => `${n.toString(16).padStart(8, "0")}${"0".repeat(56)}`;
const hit = (hash: string, quality = 100) => ({ hash, quality });

describe("hash lists", () => {
  test("parses blank, comment, CRLF, uppercase and trailing fields with stable version", () => {
    const list = parseHashList(`# hi\r\n\r\n${zero.toUpperCase()},metadata\r\n`, csam);
    expect(list.size).toBe(1);
    expect(list.version).toMatch(/^sha256:[a-f0-9]{64}:1$/);
    expect(list.nearest(zero)).toBe(0);
  });
  test("reports malformed line number and rejects missing first field", () => {
    expect(() => parseHashList(`${zero}\nnot-a-hash`, csam)).toThrow(new HashListParseError(2));
    expect(() => parseHashList(`,metadata`, csam)).toThrow(new HashListParseError(1));
  });
  test("enforces quality and distance boundaries and prioritizes CSAM ties", () => {
    const matcher = createHashMatcher([
      staticHashList(ncii, "pdq:operator-list", [zero], "ncii-v1"),
      staticHashList(csam, "pdq:operator-list", [zero], "csam-v1"),
    ]);
    expect(matcher.match(hit(zero, 49))).toBeNull();
    expect(matcher.match(hit(zero, 50))?.category).toBe(csam);
    expect(matcher.match(hit(bits(1), 50))?.distance).toBe(1);
    expect(
      createHashMatcher([staticHashList(csam, "pdq:operator-list", [zero], "v")]).match(hit(bits(0x7fffffff)))
        ?.distance,
    ).toBe(31);
    expect(
      createHashMatcher([staticHashList(csam, "pdq:operator-list", [zero], "v")]).match(hit(bits(0xffffffff))),
    ).toBeNull();
    expect(createHashMatcher([]).match(hit(zero))).toBeNull();
  });
  test("replace swaps a provider list without dropping others", () => {
    const first = staticHashList(csam, "pdq:operator-list", [zero], "old");
    const matcher = createHashMatcher([first]);
    matcher.replace(staticHashList(csam, "pdq:operator-list", [bits(1)], "new"));
    expect(matcher.lists()).toHaveLength(1);
    expect(matcher.lists()[0]?.version).toBe("new");
    expect(matcher.match(hit(bits(1)))?.listVersion).toBe("new");
  });
});
