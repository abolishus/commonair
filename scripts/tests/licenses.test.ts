// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { checkNpm } from "../check-licenses.ts";
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

describe("our own packages (ADR 0035)", () => {
  /** A fixture `node_modules` with one package per [name, license]. */
  function fixture(pkgs: [string, string][]): { root: string; done(): void } {
    const root = mkdtempSync(join(tmpdir(), "licenses-"));
    for (const [name, license] of pkgs) {
      const dir = join(root, "node_modules", ...name.split("/"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", license }));
    }
    return { root, done: () => rmSync(root, { recursive: true, force: true }) };
  }
  const reasons = (pkgs: [string, string][]) => {
    const f = fixture(pkgs);
    try {
      return checkNpm([f.root]).findings.map((x) => [x.name, x.reason]);
    } finally {
      f.done();
    }
  };

  test("the SDK is Apache-2.0 and every other package AGPL-3.0-or-later", () => {
    expect(
      reasons([
        ["@commonair/sdk", "Apache-2.0"],
        ["@commonair/db", "AGPL-3.0-or-later"],
        ["commonair", "AGPL-3.0-or-later"],
      ]),
    ).toEqual([]);
  });
  test("an AGPL SDK fails", () => {
    expect(reasons([["@commonair/sdk", "AGPL-3.0-or-later"]])).toEqual([
      ["@commonair/sdk", "own package must be Apache-2.0"],
    ]);
  });
  test("any other package of ours declared Apache-2.0 fails", () => {
    expect(reasons([["@commonair/db", "Apache-2.0"]])).toEqual([
      ["@commonair/db", "own package must be AGPL-3.0-or-later"],
    ]);
  });
});
