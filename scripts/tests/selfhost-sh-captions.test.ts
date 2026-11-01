// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live captions in selfhost.sh (fixtures: support/selfhost-host.ts): --captions installs the
 * whisper unit, fetches its weights and points media at it (WHISPER_URL); off by default, kept
 * across upgrades and reinstalls, and --no-captions removes it. On amd64 the host's CPU flags are
 * checked against the release's `COMMONAIR_CPU_WHISPER_AMD64` before anything changes.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import { linkExecutables } from "./support/exec-cache.ts";
import {
  type Host,
  INSTALL,
  TIMEOUT,
  current,
  envOf,
  expectOk,
  host as baseHost,
  useReleases,
} from "./support/selfhost-host.ts";

useReleases();

const WHISPER_URL = "http://whisper:8080";
const UNIT = "commonair-whisper.container";
const WEIGHTS = ".local/share/commonair/models/whisper-ggml-base-q5_1.bin";
const HASWELL = "fpu vme de pse tsc msr pae mce cx8 apic sse sse2 ssse3 fma cx16 sse4_1 sse4_2 avx f16c avx2 bmi2";
const SANDY_BRIDGE = "fpu vme de pse tsc msr pae mce cx8 apic sse sse2 ssse3 cx16 sse4_1 sse4_2 avx";

/** A host whose `uname -m` says `arch` and whose /proc/cpuinfo lists `flags` (none: no file). */
function host(arch = "x86_64", flags: string | null = HASWELL): Host {
  const h = baseHost();
  linkExecutables(join(h.dir, "stub"), { uname: `#!/bin/sh\n[ "$1" = -m ] && echo ${arch} || echo Linux\n` });
  if (flags !== null) {
    mkdirSync(join(h.dir, "sys/proc"), { recursive: true });
    writeFileSync(
      join(h.dir, "sys/proc/cpuinfo"),
      `processor\t: 0\nvendor_id\t: GenuineIntel\nflags\t\t: ${flags}\n\nprocessor\t: 1\nflags\t\t: ${flags}\n`,
    );
  }
  return h;
}

const units = (h: Host) => readdirSync(join(h.home, ".config/containers/systemd"));
const releaseEnv = (h: Host) => readFileSync(join(current(h), "release.env"), "utf8");
const fetches = (h: Host) => h.calls().filter((c) => c.startsWith("podman run") && c.includes("/tools/fetch-model.js"));
const pulls = (h: Host) => h.calls().filter((c) => c.startsWith("podman pull"));

describe("captions off by default", () => {
  let h: Host;
  let r: ReturnType<Host["run"]>;
  beforeAll(() => {
    h = host();
    r = h.run(INSTALL);
  }, TIMEOUT);

  test("no whisper unit, no weights, no whisper pull, WHISPER_URL empty", () => {
    expectOk(r);
    expect(units(h)).not.toContain(UNIT);
    expect(existsSync(join(h.home, WEIGHTS))).toBe(false);
    expect(fetches(h).some((c) => c.includes("--model captions"))).toBe(false);
    expect(pulls(h).some((c) => c.includes("/whisper:"))).toBe(false);
    expect(envOf(h).WHISPER_URL).toBe("");
  });

  test("the release still ships the unit and says what its amd64 build needs", () => {
    expect(existsSync(join(current(h), "quadlet", UNIT))).toBe(true);
    expect(releaseEnv(h)).toContain("COMMONAIR_CPU_WHISPER_AMD64=avx,avx2,fma,f16c\n");
  });

  test("status says captions are off", () => {
    expect(h.run(["status"]).out).toContain("captions:  off");
  });
});

describe("--captions", () => {
  let h: Host;
  let r: ReturnType<Host["run"]>;
  beforeAll(() => {
    h = host();
    r = h.run([...INSTALL, "--captions"]);
  }, TIMEOUT);

  test("installs the whisper unit, pulls its image and points media at it", () => {
    expectOk(r);
    expect(units(h)).toContain(UNIT);
    const unit = readFileSync(join(h.home, ".config/containers/systemd", UNIT), "utf8");
    expect(unit).toMatch(/^Image=ghcr\.io\/.+\/whisper:0\.1\.0@sha256:[0-9a-f]{64}$/m);
    expect(pulls(h).some((c) => c.includes("/whisper:0.1.0@sha256:"))).toBe(true);
    expect(envOf(h).WHISPER_URL).toBe(WHISPER_URL);
    expect(r.err).toContain("captions: this CPU has avx avx2 fma f16c");
  });

  test("fetches and verifies the captions weights where the unit mounts them", () => {
    expect(existsSync(join(h.home, WEIGHTS))).toBe(true);
    expect(fetches(h).some((c) => c.includes("--model captions --out /models/whisper-ggml-base-q5_1.bin"))).toBe(true);
    // The moderation model is still fetched as before.
    expect(fetches(h).some((c) => c.includes("--model moderation"))).toBe(true);
  });

  test("starts whisper with the other services and status reports it", () => {
    expect(h.calls().some((c) => /^systemctl --user start --no-block .*commonair-whisper\.service/.test(c))).toBe(true);
    expect(h.run(["status"]).out).toContain("captions:  on, commonair-whisper active, up to 2 streams");
  });

  test(
    "persists across an upgrade and a reinstall; --no-captions removes the unit and stops it",
    () => {
      expectOk(h.run(["upgrade", "--version", "v0.2.0"]));
      expect(units(h)).toContain(UNIT);
      expect(envOf(h).WHISPER_URL).toBe(WHISPER_URL);
      expectOk(h.run(["install", "--reinstall"]));
      expect(units(h)).toContain(UNIT);
      const off = h.run(["install", "--reinstall", "--no-captions"]);
      expectOk(off);
      expect(off.err).toContain("stopping commonair-whisper (not part of this install)");
      expect(units(h)).not.toContain(UNIT);
      expect(envOf(h).WHISPER_URL).toBe("");
      expect(h.run(["status"]).out).toContain("captions:  off");
    },
    TIMEOUT,
  );

  test("warns when CAPTIONS_MAX_STREAMS=0 leaves the sidecar with nothing to do", () => {
    const g = host();
    expectOk(g.run(INSTALL));
    const path = join(g.home, ".config/commonair/commonair.env");
    writeFileSync(path, readFileSync(path, "utf8").replace(/^CAPTIONS_MAX_STREAMS=.*$/m, "CAPTIONS_MAX_STREAMS=0"));
    const on = g.run(["install", "--reinstall", "--captions"]);
    expectOk(on);
    expect(on.err).toContain("captions are on but CAPTIONS_MAX_STREAMS=0");
  });
});

describe("turning captions on later", () => {
  test(
    "--captions on upgrade installs the unit; an operator's own WHISPER_URL installs nothing",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      expectOk(h.run(["upgrade", "--version", "v0.2.0", "--captions"]));
      expect(units(h)).toContain(UNIT);
      expect(existsSync(join(h.home, WEIGHTS))).toBe(true);

      const own = host();
      expectOk(own.run(INSTALL));
      const path = join(own.home, ".config/commonair/commonair.env");
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(/^WHISPER_URL=.*$/m, "WHISPER_URL=http://asr.internal:8080"),
      );
      expectOk(own.run(["install", "--reinstall"]));
      expect(units(own)).not.toContain(UNIT);
      expect(envOf(own).WHISPER_URL).toBe("http://asr.internal:8080");
    },
    TIMEOUT,
  );

  test("--captions-model installs a local copy of the weights", () => {
    const h = host();
    const copy = join(h.dir, "whisper.bin");
    writeFileSync(copy, "weights");
    expectOk(h.run([...INSTALL, "--captions", "--captions-model", copy]));
    expect(readFileSync(join(h.home, WEIGHTS), "utf8")).toBe("weights");
  });

  test("weights that fail verification stop the install before any unit is installed", () => {
    const h = host();
    const r = h.run([...INSTALL, "--captions"], { STUB_CAPTIONS_MODEL_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("the captions model is missing or does not match its pinned sha256");
    expect(r.err).toContain("--captions-model <path>");
    expect(existsSync(join(h.home, ".config/containers/systemd"))).toBe(false);
  });
});

describe("the CPU check", () => {
  test("an amd64 CPU without AVX2, FMA and F16C is refused before anything is pulled", () => {
    const h = host("x86_64", SANDY_BRIDGE);
    const r = h.run([...INSTALL, "--captions"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("live captions need a CPU with avx avx2 fma f16c; this one lacks: avx2 fma f16c");
    expect(r.err).toContain("SIGILL");
    expect(r.err).toContain("fix: re-run with --no-captions");
    expect(pulls(h)).toEqual([]);
    expect(existsSync(join(h.home, ".config/commonair/commonair.env"))).toBe(false);
    // The same host installs fine without captions.
    expectOk(h.run(INSTALL));
  });

  test("an unreadable /proc/cpuinfo on amd64 is refused", () => {
    const r = host("x86_64", null).run([...INSTALL, "--captions"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot read this CPU's flags from /proc/cpuinfo");
  });

  test("an upgrade that keeps captions on a CPU without AVX2 changes nothing", () => {
    const h = host("x86_64", HASWELL);
    expectOk(h.run([...INSTALL, "--captions"]));
    writeFileSync(join(h.dir, "sys/proc/cpuinfo"), `flags\t\t: ${SANDY_BRIDGE}\n`);
    const r = h.run(["upgrade", "--version", "v0.2.0"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("this one lacks:");
    expect(current(h)).toContain("0.1.0");
  });

  test("arm64 needs nothing beyond its baseline", () => {
    const h = host("aarch64", null);
    const r = h.run([...INSTALL, "--captions"]);
    expectOk(r);
    expect(units(h)).toContain(UNIT);
    expect(r.err).not.toContain("captions: this CPU has");
  });
});

describe("arguments", () => {
  test("--captions-model with --no-captions is refused", () => {
    const r = host().run([...INSTALL, "--no-captions", "--captions-model", "/tmp/x.bin"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--captions-model and --no-captions contradict each other");
  });

  test("--help documents the option and its CPU requirement", () => {
    const r = host().run(["--help"]);
    expectOk(r);
    expect(r.out).toContain("--captions ");
    expect(r.out).toContain("--no-captions");
    expect(r.out).toContain("AVX2");
  });
});
