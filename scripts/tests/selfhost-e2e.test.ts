// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The parts of the end-to-end test that need no podman: how it builds and what it runs on. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { RELEASE_IMAGES } from "../release/manifest.ts";
import { HOST_IMAGES, ZOT_IMAGE, buildSpecs, hostContainerfile, migratedFirst } from "../selfhost/e2e.ts";

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
      for (const pkg of ["systemd", "podman", "catatonit", "passt", "curl"]) expect(file).toContain(` ${pkg}`);
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
