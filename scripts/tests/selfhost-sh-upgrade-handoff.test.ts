// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * selfhost.sh under `sh` (fixtures: support/selfhost-host.ts). Upgrades hand off to the target
 * release's own selfhost.sh once its bundle is verified (staging on rc.9 could not upgrade to
 * rc.11 with its own script). Release 0.2.0 here ships a script that says it ran.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { buildBundle } from "../selfhost/bundle.ts";
import {
  SCRIPT,
  TIMEOUT,
  host,
  INSTALL,
  current,
  expectOk,
  manifestJson,
  useReleases,
} from "./support/selfhost-host.ts";

useReleases();

const MARK = "selfhost-0.2.0-script";
/** The tree's script, plus a line saying it ran and with which arguments. */
const markedScript = () =>
  readFileSync(SCRIPT, "utf8").replace(/^#!\/bin\/sh\n/, `#!/bin/sh\nprintf '${MARK} %s\\n' "$*" >&2\n`);

/** Release assets where 0.2.0's bundle carries the marked script. */
let handoffReleases: string;

beforeAll(async () => {
  handoffReleases = mkdtempSync(join(tmpdir(), "commonair-selfhost-handoff-"));
  const sums: string[] = [];
  for (const [i, v] of (["0.1.0", "0.2.0"] as const).entries()) {
    const { name, data } = await buildBundle({
      manifestJson: manifestJson(v, i + 1),
      ...(v === "0.2.0" ? { script: markedScript() } : {}),
    });
    writeFileSync(join(handoffReleases, name), data);
    sums.push(`${createHash("sha256").update(data).digest("hex")}  ${name}`);
  }
  writeFileSync(join(handoffReleases, "SHA256SUMS"), `${sums.join("\n")}\n`);
}, TIMEOUT);
afterAll(() => rmSync(handoffReleases, { recursive: true, force: true }));

const ran = (err: string) => err.split("\n").filter((l) => l.startsWith(`${MARK} `));
const bundleFetches = (calls: string[]) =>
  calls.filter((c) => c.startsWith("curl") && c.includes("commonair-selfhost_0.2.0.tar.gz")).length;

describe("upgrade hands off to the target release's selfhost.sh", () => {
  test("once, with the same arguments, from the bundle already verified", () => {
    const h = host();
    const env = { STUB_RELEASES: handoffReleases };
    expectOk(h.run(INSTALL, env));
    const r = h.run(["upgrade", "--version", "v0.2.0"], env);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("handing the upgrade to release 0.2.0's selfhost.sh");
    // The target ran once (its marker stops a second hand-off) and finished the upgrade.
    expect(ran(r.err)).toEqual([`${MARK} upgrade --version v0.2.0`]);
    expect(r.err).toContain("upgraded to 0.2.0");
    // It verified the handed bundle again but did not download it again.
    expect(bundleFetches(h.calls())).toBe(1);
    expect(r.err.match(/checksum ok: commonair-selfhost_0\.2\.0\.tar\.gz/g)).toHaveLength(2);
    // ~/commonair is the new release, so ~/commonair/selfhost.sh is now its script.
    expect(current(h)).toBe(join(h.home, ".local/share/commonair/releases/0.2.0"));
    expect(readFileSync(join(h.home, "commonair/selfhost.sh"), "utf8")).toBe(markedScript());
  });

  test("a --bundle upgrade hands off too", () => {
    const h = host();
    const env = { STUB_RELEASES: handoffReleases };
    expectOk(h.run(INSTALL, env));
    const local = join(h.dir, "local");
    mkdirSync(local);
    for (const f of ["commonair-selfhost_0.2.0.tar.gz", "SHA256SUMS"])
      copyFileSync(join(handoffReleases, f), join(local, f));
    const bundle = join(local, "commonair-selfhost_0.2.0.tar.gz");
    const r = h.run(["upgrade", "--bundle", bundle], env);
    expect(r.code, r.err).toBe(0);
    expect(ran(r.err)).toEqual([`${MARK} upgrade --bundle ${bundle}`]);
    expect(current(h)).toBe(join(h.home, ".local/share/commonair/releases/0.2.0"));
  });

  test("the target's failure is the upgrade's: it rolls back and the exit status carries over", () => {
    const h = host();
    const env = { STUB_RELEASES: handoffReleases };
    expectOk(h.run(INSTALL, env));
    const r = h.run(["upgrade", "--version", "v0.2.0"], { ...env, STUB_MIGRATE_FAIL: "0.2.0" });
    expect(r.code).toBe(1);
    expect(ran(r.err)).toHaveLength(1);
    expect(r.err).toContain("rolled back to 0.1.0, which is healthy");
    expect(current(h)).toBe(join(h.home, ".local/share/commonair/releases/0.1.0"));
  });

  test("no hand-off when the target's script is this one", () => {
    const h = host();
    expectOk(h.run(INSTALL));
    const r = h.run(["upgrade", "--version", "v0.2.0"]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).not.toContain("handing the upgrade");
    expect(bundleFetches(h.calls())).toBe(1);
  });

  test("a handed-off run never hands off again", () => {
    const h = host();
    const env = { STUB_RELEASES: handoffReleases };
    expectOk(h.run(INSTALL, env));
    // As the target would be run, without the bundle: it downloads, and upgrades itself.
    const r = h.run(["upgrade", "--version", "v0.2.0"], { ...env, COMMONAIR_UPGRADE_HANDOFF: "0.2.0" });
    expect(r.code, r.err).toBe(0);
    expect(r.err).not.toContain("handing the upgrade");
    expect(ran(r.err)).toEqual([]);
  });

  test("a handed bundle is verified again: one that does not match its checksum file is refused", () => {
    const h = host();
    const env = { STUB_RELEASES: handoffReleases };
    expectOk(h.run(INSTALL, env));
    const dir = join(h.dir, "handed");
    mkdirSync(dir);
    const bundle = join(dir, "commonair-selfhost_0.2.0.tar.gz");
    copyFileSync(join(handoffReleases, "commonair-selfhost_0.2.0.tar.gz"), bundle);
    writeFileSync(join(dir, "SHA256SUMS"), `${"0".repeat(64)}  commonair-selfhost_0.2.0.tar.gz\n`);
    const r = h.run(["upgrade", "--version", "v0.2.0"], {
      ...env,
      COMMONAIR_UPGRADE_HANDOFF: "0.2.0",
      COMMONAIR_UPGRADE_BUNDLE: bundle,
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("checksum mismatch for commonair-selfhost_0.2.0.tar.gz");
    expect(current(h)).toBe(join(h.home, ".local/share/commonair/releases/0.1.0"));
    expect(bundleFetches(h.calls())).toBe(0);
  });

  test("a handed bundle of another version than the hand-off names is refused", () => {
    const h = host();
    const env = { STUB_RELEASES: handoffReleases };
    expectOk(h.run(INSTALL, env));
    const dir = join(h.dir, "handed");
    mkdirSync(dir);
    for (const f of ["commonair-selfhost_0.2.0.tar.gz", "SHA256SUMS"])
      copyFileSync(join(handoffReleases, f), join(dir, f));
    const r = h.run(["upgrade", "--version", "v0.2.0"], {
      ...env,
      COMMONAIR_UPGRADE_HANDOFF: "0.3.0",
      COMMONAIR_UPGRADE_BUNDLE: join(dir, "commonair-selfhost_0.2.0.tar.gz"),
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("handed release 0.3.0's upgrade, but the bundle is 0.2.0");
  });
});
