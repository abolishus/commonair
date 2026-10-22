// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// relay/Makefile's `release` must build what the release workflow builds (scripts/release/relay.ts):
// the same targets, the same file names and the same flags, so a maintainer's local build can
// be compared byte for byte with the published binaries.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { RELAY_TARGETS, relayAssetName } from "../release/manifest.ts";
import { RELAY_PACKAGE, relayBuild } from "../release/relay.ts";

const relayDir = join(import.meta.dirname, "..", "..", "relay");
const makefile = readFileSync(join(relayDir, "Makefile"), "utf8");

/** The right-hand side of a `NAME := …` or `NAME = …` line. */
function variable(name: string): string {
  const m = makefile.match(new RegExp(`^${name}\\s*:?=\\s*(.*)$`, "m"));
  if (!m?.[1]) throw new Error(`${name} is not set in relay/Makefile`);
  return m[1].trim();
}

describe("relay/Makefile (static)", () => {
  test("PLATFORMS is RELAY_TARGETS, in order", () => {
    expect(variable("PLATFORMS").split(/\s+/)).toEqual([...RELAY_TARGETS]);
  });

  test("the version loses a leading v, as versionFromTag does", () => {
    expect(variable("VER")).toBe("$(patsubst v%,%,$(VERSION))");
  });

  test("ldflags are relay.ts's, with the stripped version", () => {
    const ldflags = relayBuild("$(VER)", "linux/amd64", "bin").argv;
    expect(variable("LDFLAGS")).toBe(ldflags[ldflags.indexOf("-ldflags") + 1]);
    expect(variable("GOFLAGS_BUILD")).toBe('-trimpath -buildvcs=false -ldflags "$(LDFLAGS)"');
    expect(variable("PKG")).toBe(RELAY_PACKAGE);
  });

  test("the asset name template has relayAssetName's shape", () => {
    // relayAssetName("$(VER)", t) with the os and arch left as the Makefile's function calls.
    const asset = variable("asset");
    const [prefix] = relayAssetName("$(VER)", "linux/amd64").split("linux_amd64");
    expect(asset.startsWith(`${prefix}$(call os,$(1))_$(call arch,$(1))`)).toBe(true);
    expect(asset).toContain("$(if $(filter windows,$(call os,$(1))),.exe,)");
  });
});

const make = Bun.which("make");

describe.skipIf(!make)("make -n release", () => {
  const dryRun = (version: string) => {
    const r = Bun.spawnSync(["make", "-n", "release", `VERSION=${version}`], { cwd: relayDir });
    expect(r.exitCode).toBe(0);
    // Join recipe continuation lines so each command reads as one line.
    return r.stdout.toString().replace(/\\\n\s*/g, "");
  };

  for (const version of ["v0.0.0-test", "0.0.0-test"]) {
    test(`builds every target under its release name (VERSION=${version})`, () => {
      const out = dryRun(version);
      for (const target of RELAY_TARGETS) {
        const b = relayBuild("0.0.0-test", target, "bin");
        const [, , ...flags] = b.argv;
        const ldflagsAt = flags.indexOf("-ldflags") + 1;
        flags[ldflagsAt] = `"${flags[ldflagsAt]}"`;
        const env = Object.entries(b.env)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
        expect(out).toContain(`${env} go build ${flags.join(" ")}\n`);
        expect(b.out).toBe(`bin/${relayAssetName("0.0.0-test", target)}`);
      }
    });
  }

  test("SHA256SUMS covers exactly the six release binaries", () => {
    const out = dryRun("v0.0.0-test");
    const names = RELAY_TARGETS.map((t) => relayAssetName("0.0.0-test", t)).join(" ");
    expect(out).toContain(`sha256sum ${names};`);
    expect(out).toContain(`shasum -a 256 ${names};`);
  });
});
