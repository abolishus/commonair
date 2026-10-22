// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The parts of the end-to-end test that need no podman: how it builds and what it runs on. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { RELEASE_IMAGES } from "../release/manifest.ts";
import { HOST_IMAGES, ZOT_IMAGE, buildSpecs, hostContainerfile } from "../selfhost/e2e.ts";

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
