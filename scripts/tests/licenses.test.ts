// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { evaluate, licenseOf } from "../licenses.ts";

describe("license policy", () => {
  test.each([
    "MIT",
    "Apache-2.0",
    "(MIT OR Apache-2.0)",
    "BSD-3-Clause AND ISC",
    "GPL-2.0+",
    "LGPL-3.0",
    "OFL-1.1",
    "Unlicense",
    "GPL-2.0-only WITH Classpath-exception-2.0",
  ])("allows %s", (id) => expect(evaluate(id)).toEqual({ ok: true }));

  test.each([
    "BUSL-1.1",
    "SSPL-1.0",
    "Elastic-2.0",
    "RSAL",
    "MIT AND Commons-Clause",
    "CC-BY-NC-4.0",
    "UNLICENSED",
    "UNKNOWN",
    "SEE LICENSE IN LICENSE",
  ])("refuses %s", (id) => expect(evaluate(id).ok).toBe(false));

  test("WITH accepts only known license exceptions", () => {
    expect(evaluate("GPL-2.0-only WITH Classpath-exception-2.0").ok).toBe(true);
    expect(evaluate("GPL-2.0-only WITH Anything-Goes").ok).toBe(false);
  });

  test("bare BSD is ambiguous and refused", () => {
    expect(evaluate("BSD").ok).toBe(false);
  });

  test("OR passes when either side is allowed; AND requires both", () => {
    expect(evaluate("(BUSL-1.1 OR MIT)").ok).toBe(true);
    expect(evaluate("(BUSL-1.1 AND MIT)").ok).toBe(false);
  });

  test("Boost (BSL-1.0) is allowed but Business Source (BUSL) is not", () => {
    expect(evaluate("BSL-1.0").ok).toBe(true);
    expect(evaluate("BUSL-1.0").ok).toBe(false);
  });

  test("normalizes legacy package.json shapes", () => {
    expect(licenseOf({ license: "MIT" })).toBe("MIT");
    expect(licenseOf({ license: { type: "ISC" } })).toBe("ISC");
    expect(licenseOf({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe("(MIT OR Apache-2.0)");
    expect(licenseOf({})).toBeUndefined();
  });
});
