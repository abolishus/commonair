// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** d7-security: the harness TOTP against RFC 6238's vectors, and every selector the web renders. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { base32Decode, hotp, msToNextPeriod, totp } from "../src/d7/security.ts";
import { D7_SECURITY_IDS } from "../src/web/selectors.ts";

// RFC 6238 appendix B: the SHA-1 seed "12345678901234567890", 8 digits; 6 digits are the last six.
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("RFC 6238 TOTP", () => {
  test("decodes base32", () => {
    expect(base32Decode(SEED).toString("ascii")).toBe("12345678901234567890");
    expect(base32Decode("gezd gnbv").toString("ascii")).toBe("12345");
    expect(() => base32Decode("1!")).toThrow("not base32");
  });

  test.each([
    [59, "287082"],
    [1_111_111_109, "081804"],
    [1_111_111_111, "050471"],
    [1_234_567_890, "005924"],
    [2_000_000_000, "279037"],
  ])("T = %i s → %s", (seconds, code) => {
    expect(totp(SEED, seconds * 1000)).toBe(code);
  });

  test("RFC 4226 HOTP vectors", () => {
    const key = Buffer.from("12345678901234567890");
    expect([0, 1, 2, 9].map((c) => hotp(key, c))).toEqual(["755224", "287082", "359152", "520489"]);
  });

  test("time to the next period", () => {
    expect(msToNextPeriod(0)).toBe(30_000);
    expect(msToNextPeriod(29_500)).toBe(500);
  });
});

const WEB = new URL("../../apps/web/src/", import.meta.url).pathname;
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}
const source = [
  ...sources(join(WEB, "components/security")),
  join(WEB, "routes/_app/signin.tsx"),
  // The page header and its `security-page` wrapper live in the route (the settings page pattern).
  join(WEB, "routes/_app/settings.security.tsx"),
]
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

describe("D7_SECURITY_IDS", () => {
  test.each(Object.entries(D7_SECURITY_IDS))("%s (%s) is a test id the web renders", (_name, id) => {
    expect(
      source.includes(`data-testid="${id}"`) ||
        source.includes(`data-value-testid="${id}"`) ||
        source.includes(`data-reveal-testid="${id}"`),
    ).toBe(true);
  });

  test("the values are unique", () => {
    const values = Object.values(D7_SECURITY_IDS);
    expect(new Set(values).size).toBe(values.length);
  });
});
