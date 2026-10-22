// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The export link helpers: find, read the expiry, tamper, strip. */
import { exportObjectKey } from "@commonair/contracts/internal";
import { describe, expect, test } from "vite-plus/test";
import {
  exportLinkIn,
  isPresignedFor,
  presignExpiresSeconds,
  secondsBetween,
  tamperSignature,
  unsignedUrl,
} from "../../src/e6/signed-url.ts";

const USER = "0198a1b2-0000-7000-8000-00000000000a";
const EXPORT = "0198a1b2-0000-7000-8000-00000000000b";
const KEY = exportObjectKey(USER, EXPORT);
const SIG = "ab12cd34".repeat(8);
const presigned = (key = KEY, sig = SIG) =>
  `http://localhost:3900/commonair-exports/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=x%2F20261022%2Fgarage%2Fs3%2Faws4_request&X-Amz-Date=20261022T000000Z&X-Amz-Expires=604800&X-Amz-SignedHeaders=host&X-Amz-Signature=${sig}`;

describe("export link helpers", () => {
  test("isPresignedFor matches only that key, with a signature", () => {
    expect(isPresignedFor(presigned(), KEY)).toBe(true);
    expect(isPresignedFor(`https://commonair-exports.s3.example/${KEY}?X-Amz-Signature=1`, KEY)).toBe(true);
    expect(isPresignedFor(presigned(exportObjectKey(USER, "other")), KEY)).toBe(false);
    expect(isPresignedFor(unsignedUrl(presigned()), KEY)).toBe(false);
    expect(isPresignedFor("not a url", KEY)).toBe(false);
    // A key that merely ends the same way under another user does not match.
    expect(isPresignedFor(presigned(`exports/x${USER}/${EXPORT}.zip`), KEY)).toBe(false);
  });

  test("exportLinkIn picks the export's link among a mail's links", () => {
    const links = ["http://localhost:3000/settings/privacy", presigned(exportObjectKey(USER, "e2")), presigned()];
    expect(exportLinkIn(links, USER, EXPORT)).toBe(presigned());
    expect(exportLinkIn(links.slice(0, 2), USER, EXPORT)).toBeNull();
  });

  test("presignExpiresSeconds", () => {
    expect(presignExpiresSeconds(presigned())).toBe(604_800);
    expect(presignExpiresSeconds("http://h/k?X-Amz-Expires=abc")).toBeNull();
    expect(presignExpiresSeconds("http://h/k")).toBeNull();
  });

  test("tamperSignature changes exactly one signature character", () => {
    const t = tamperSignature(presigned());
    const before = new URL(presigned()).searchParams.get("X-Amz-Signature") ?? "";
    const after = new URL(t).searchParams.get("X-Amz-Signature") ?? "";
    expect(after).toHaveLength(before.length);
    expect(after.split("").filter((c, i) => c !== before[i])).toHaveLength(1);
    const zero = tamperSignature(presigned(KEY, `0${SIG.slice(1)}`));
    expect(new URL(zero).searchParams.get("X-Amz-Signature")?.[0]).toBe("1");
    // Everything else is untouched.
    const a = new URL(t);
    const b = new URL(presigned());
    a.searchParams.delete("X-Amz-Signature");
    b.searchParams.delete("X-Amz-Signature");
    expect(a.toString()).toBe(b.toString());
    expect(() => tamperSignature(unsignedUrl(presigned()))).toThrow(/no signature/);
  });

  test("unsignedUrl drops the whole query", () => {
    expect(unsignedUrl(presigned())).toBe(`http://localhost:3900/commonair-exports/${KEY}`);
  });

  test("secondsBetween", () => {
    expect(secondsBetween("2026-10-22T00:00:00.000Z", "2026-10-29T00:00:00.400Z")).toBe(604_800);
    expect(secondsBetween("2026-10-22T00:00:10Z", "2026-10-22T00:00:00Z")).toBe(-10);
  });
});
