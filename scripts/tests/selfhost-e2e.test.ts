// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The parts of the end-to-end test that need no podman: how it builds and what it runs on. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { RELEASE_IMAGES } from "../release/manifest.ts";
import { HOST_IMAGES, ZOT_IMAGE, buildSpecs, hostContainerfile, hostRunArgs, migratedFirst } from "../selfhost/e2e.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const licenses = JSON.parse(readFileSync(join(ROOT, "infra/image-licenses.json"), "utf8")) as Record<
  string,
  { tag: string }
>;
const PINNED = /^([a-z0-9.-]+\/[a-z0-9._/-]+):([\w.-]+)@sha256:[0-9a-f]{64}$/;

describe("e2e build specs", () => {
  const specs = buildSpecs();

  test("every release image has a build from compose.yaml (relay from its own Containerfile)", () => {
    expect(Object.keys(specs).sort()).toEqual([...RELEASE_IMAGES].sort());
    for (const [name, spec] of Object.entries(specs)) expect(existsSync(join(ROOT, spec.file)), name).toBe(true);
    expect(specs.api.args).toEqual({ SERVICE: "api" });
    expect(specs.tools.args).toEqual({ SERVICE: "tools" });
    expect(specs.postgres.file).toBe("infra/postgres/Containerfile");
    expect(specs.loki.args.BASE_IMAGE).toMatch(PINNED);
    expect(specs.relay).toEqual({ file: "relay/Containerfile", context: "relay", args: {} });
  });
});

describe("e2e images", () => {
  test.each([ZOT_IMAGE, ...Object.values(HOST_IMAGES)])("%s is pinned and licensed", (ref) => {
    const m = PINNED.exec(ref);
    expect(m).not.toBeNull();
    expect(licenses[m![1]!]?.tag).toBe(m![2]);
  });

  test.each(Object.keys(HOST_IMAGES) as (keyof typeof HOST_IMAGES)[])(
    "%s host: systemd as PID 1, Podman with catatonit, the e2e registry marked insecure",
    (distro) => {
      const file = hostContainerfile(distro);
      expect(file.startsWith(`FROM ${HOST_IMAGES[distro]}\n`)).toBe(true);
      for (const pkg of ["systemd", "curl"]) expect(file).toContain(` ${pkg}`);
      // Like a fresh server: selfhost.sh installs Podman and its helpers, as an operator's would.
      for (const pkg of ["podman", "catatonit", "passt", "aardvark-dns", "nftables"])
        expect(file).not.toContain(` ${pkg}`);
      expect(file).toContain('CMD ["/sbin/init"]');
      expect(file).toContain("insecure = true");
    },
  );
});

describe("e2e: the upgrade re-ran migrate before api and worker", () => {
  const before = { invocation: "aaa", started: 1_000 };
  test("passes when migrate ran again and finished before both started", () => {
    expect(
      migratedFirst(before, { invocation: "bbb", started: 5_000, exited: 6_000 }, { api: 7_000, worker: 7_100 }),
    ).toEqual([]);
  });

  test("fails when the upgrade skipped migrate (the install's run is still the last one)", () => {
    const stale = { ...before, exited: 1_500 };
    const problems = migratedFirst(before, stale, { api: 7_000, worker: 7_100 });
    expect(problems.some((p) => p.includes("did not run again"))).toBe(true);
    expect(problems.some((p) => p.includes("not after the pre-upgrade one"))).toBe(true);
  });

  test("fails when api or worker started before migrate finished", () => {
    const problems = migratedFirst(
      before,
      { invocation: "bbb", started: 5_000, exited: 6_000 },
      { api: 5_500, worker: 7_000 },
    );
    expect(problems).toEqual(["api started at 5500, before migrate finished at 6000"]);
  });
});

describe("e2e: the outer podman is CI's rootful Podman 4.9", () => {
  const args = hostRunArgs("localhost/commonair-e2e/host-debian:latest", null, "10.89.0.2");

  test("the host container resolves the registry by --add-host, not by network DNS", () => {
    // CNI without the dnsname plugin (Podman 4 on some distributions) has no container DNS.
    expect(args.join(" ")).toContain("--add-host commonair-e2e-zot:10.89.0.2");
  });

  test("the host container uses only flags Podman 4.9 has", () => {
    const PODMAN_4_9 = new Set([
      "-d",
      "--name",
      "--hostname",
      "--privileged",
      "--systemd",
      "--network",
      "--add-host",
      "-v",
    ]);
    const flags = args.filter((a) => a.startsWith("-")).map((a) => a.replace(/=.*$/, ""));
    expect(flags.filter((f) => !PODMAN_4_9.has(f))).toEqual([]);
  });

  test("every outer podman flag in e2e.ts is one Podman 4.9 has", () => {
    const src = readFileSync(join(ROOT, "scripts/selfhost/e2e.ts"), "utf8");
    // String literals that are flags, outside the inner (in-host) shell scripts.
    const flags = new Set([...src.matchAll(/"(--?[a-z][a-z-]*)(?:=[^"]*)?"/g)].map((m) => m[1]!));
    const KNOWN = new Set([
      "-a",
      "-c",
      "-d",
      "-e",
      "-f",
      "-p",
      "-t",
      "-u",
      "-v",
      "-w",
      "--add-host",
      "--build-arg",
      "--digestfile",
      "--distro",
      "--format",
      "--hostname",
      "--keep",
      "--label",
      "--name",
      "--network",
      "--privileged",
      "--systemd",
      "--tls-verify",
    ]);
    expect([...flags].filter((f) => !KNOWN.has(f)).sort()).toEqual([]);
  });
});

describe("CI job", () => {
  test("unloads the runner's unix-chkpwd AppArmor profile before the end-to-end run", () => {
    // Without it the Fedora host's user manager fails PAM on ubuntu-24.04 runners.
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const job = ci.slice(ci.indexOf("\n  selfhost-e2e:"), ci.indexOf("\n  ci-ok:"));
    const unload = job.indexOf("apparmor_parser -R /etc/apparmor.d/unix-chkpwd");
    expect(unload).toBeGreaterThan(0);
    expect(unload).toBeLessThan(job.indexOf("scripts/selfhost/e2e.ts"));
  });
});
