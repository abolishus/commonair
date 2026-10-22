// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { type Packument, assess, parseSpec, pickVersion } from "../vet-package.ts";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function packument(over: Partial<Packument> = {}): Packument {
  return {
    name: "lib",
    "dist-tags": { latest: "2.0.0" },
    time: { created: daysAgo(900), "1.0.0": daysAgo(400), "2.0.0": daysAgo(30), "2.1.0-rc.1": daysAgo(1) },
    versions: {
      "1.0.0": { version: "1.0.0", license: "MIT", _npmUser: { name: "alice" }, dist: { attestations: {} } },
      "2.0.0": { version: "2.0.0", license: "MIT", _npmUser: { name: "alice" }, dist: { attestations: {} } },
      "2.1.0-rc.1": { version: "2.1.0-rc.1", license: "MIT" },
    },
    ...over,
  };
}

describe("parseSpec", () => {
  test.each([
    ["zod", { name: "zod" }],
    ["zod@4.6.7", { name: "zod", version: "4.6.7" }],
    ["@orpc/server", { name: "@orpc/server" }],
    ["@orpc/server@1.15.7", { name: "@orpc/server", version: "1.15.7" }],
    ["zod@", { name: "zod" }],
  ])("%s", (spec, want) => expect(parseSpec(spec)).toEqual(want));
});

describe("pickVersion", () => {
  test("an explicit version wins", () => expect(pickVersion(packument(), "1.0.0", NOW)).toBe("1.0.0"));
  test("latest when it is past the cooldown", () => expect(pickVersion(packument(), undefined, NOW)).toBe("2.0.0"));
  test("otherwise the newest stable version past the cooldown", () => {
    const p = packument();
    p["dist-tags"].latest = "2.0.0";
    p.time["2.0.0"] = daysAgo(2);
    expect(pickVersion(p, undefined, NOW)).toBe("1.0.0");
  });
  test("falls back to latest when nothing is old enough, so assess can fail it", () => {
    const p = packument({ time: { created: daysAgo(3), "1.0.0": daysAgo(3), "2.0.0": daysAgo(1) } });
    expect(pickVersion(p, undefined, NOW)).toBe("2.0.0");
  });
});

describe("assess", () => {
  test("a clean, old, attested, OSI-licensed release passes with no warnings", () => {
    const a = assess(packument(), "2.0.0", NOW, [], 50_000);
    expect(a.fails).toEqual([]);
    expect(a.warns).toEqual([]);
    expect(a.notes).toContain("license MIT");
  });

  test("an unknown version fails", () =>
    expect(assess(packument(), "9.9.9", NOW, [], null).fails[0]).toMatch(/does not exist/));

  test("the cooldown boundary: 7 days passes, just under fails", () => {
    const p = packument();
    p.time["2.0.0"] = daysAgo(7);
    expect(assess(p, "2.0.0", NOW, [], null).fails).toEqual([]);
    p.time["2.0.0"] = new Date(NOW - 7 * 86_400_000 + 60_000).toISOString();
    expect(assess(p, "2.0.0", NOW, [], null).fails[0]).toMatch(/cooldown is 7 days/);
  });

  test("missing publish time fails", () => {
    const p = packument();
    delete p.time["2.0.0"];
    expect(assess(p, "2.0.0", NOW, [], null).fails[0]).toMatch(/no publish time/);
  });

  test("known vulnerabilities, deprecation and non-OSI licenses fail", () => {
    const p = packument();
    p.versions["2.0.0"] = { ...p.versions["2.0.0"]!, deprecated: "use v3", license: "BUSL-1.1" };
    const a = assess(p, "2.0.0", NOW, [{ id: "GHSA-xxxx-yyyy-zzzz", summary: "RCE" }], null);
    expect(a.fails).toEqual([
      "known vulnerability GHSA-xxxx-yyyy-zzzz: RCE",
      "deprecated: use v3",
      expect.stringMatching(/^license BUSL-1.1/),
    ]);
  });

  test("install scripts, no provenance, a new publisher, a new package and low downloads warn", () => {
    const p = packument();
    p.time.created = daysAgo(40);
    p.versions["2.0.0"] = {
      version: "2.0.0",
      license: "MIT",
      scripts: { postinstall: "node x.js", test: "vitest", preinstall: "curl" },
      _npmUser: { name: "mallory" },
    };
    const a = assess(p, "2.0.0", NOW, [], 12);
    expect(a.fails).toEqual([]);
    expect(a.warns).toEqual([
      expect.stringMatching(/^declares preinstall, postinstall|^declares postinstall, preinstall/),
      expect.stringMatching(/provenance/),
      expect.stringMatching(/mallory; the previous version 1.0.0 by alice/),
      "the package itself is only 40 days old",
      expect.stringMatching(/^12 downloads/),
    ]);
  });

  test("the first version has no previous publisher to compare", () => {
    const p = packument();
    p.versions["1.0.0"]!._npmUser = { name: "bob" };
    expect(assess(p, "1.0.0", NOW, [], null).warns).toEqual([]);
  });

  test("prereleases are not the previous version", () => {
    const p = packument();
    p.time["2.1.0"] = daysAgo(10);
    p.versions["2.1.0"] = { version: "2.1.0", license: "MIT", _npmUser: { name: "alice" }, dist: { attestations: {} } };
    expect(assess(p, "2.1.0", NOW, [], null).warns).toEqual([]);
  });
});
