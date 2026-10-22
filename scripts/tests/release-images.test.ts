// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  IMAGE_LICENSES,
  RELAY_BUILD,
  buildArgv,
  buildMatrix,
  composeBuilds,
  declaredArgs,
  parsePlatforms,
  releaseBuilds,
  utcTimestamp,
} from "../release/images.ts";
import { RELEASE_IMAGES } from "../release/manifest.ts";

const root = join(import.meta.dirname, "..", "..");
const composeText = readFileSync(join(root, "compose.yaml"), "utf8");
const compose = Bun.YAML.parse(composeText) as {
  services: Record<
    string,
    { image?: string; build?: { context: string; dockerfile: string; args?: Record<string, string> } }
  >;
};

describe("release builds", () => {
  const builds = releaseBuilds(composeText);

  test("cover exactly RELEASE_IMAGES, in order", () => {
    expect(builds.map((b) => b.image)).toEqual([...RELEASE_IMAGES]);
  });

  test("build args, context and Containerfile match compose for every built service", () => {
    const services = Object.entries(compose.services).filter(([, s]) => s.build);
    expect(services.length).toBeGreaterThan(0);
    for (const [name, s] of services) {
      const image = /\/([a-z0-9-]+):\$\{IMAGE_TAG/.exec(s.image ?? "")?.[1];
      const b = builds.find((x) => x.image === image);
      expect(b, name).toBeDefined();
      expect(b?.context, name).toBe(s.build?.context);
      expect(b?.containerfile, name).toBe(s.build?.dockerfile);
      expect(b?.args, name).toEqual(s.build?.args ?? {});
    }
  });

  test("every Containerfile exists", () => {
    for (const b of builds) expect(() => readFileSync(join(root, b.containerfile)), b.image).not.toThrow();
  });

  test("the relay is included, built from relay/ with its own Containerfile", () => {
    expect(builds.find((b) => b.image === "relay")).toEqual(RELAY_BUILD);
    expect(RELAY_BUILD).toMatchObject({ context: "relay", containerfile: "relay/Containerfile" });
    expect(declaredArgs(readFileSync(join(root, "relay/Containerfile"), "utf8")).has("VERSION")).toBe(true);
  });

  // JSON is YAML, so variants of compose can be built as objects.
  const variant = (edit: (services: typeof compose.services) => void) => {
    const doc = structuredClone(compose);
    edit(doc.services);
    return JSON.stringify(doc);
  };

  test("an image compose builds that is not a release image fails", () => {
    const doc = variant((s) => {
      s.extra = {
        image: "${IMAGE_REGISTRY:-localhost/commonair}/extra:${IMAGE_TAG:-dev}",
        build: { context: ".", dockerfile: "x" },
      };
    });
    expect(() => composeBuilds(doc)).toThrow("not in RELEASE_IMAGES");
  });

  test("a release image compose stops building fails", () => {
    const doc = variant((s) => {
      delete s.postgres?.build;
    });
    expect(() => releaseBuilds(doc)).toThrow("no build for release images: postgres");
  });

  test("two services building the same image differently fails", () => {
    const doc = variant((s) => {
      const b = s["garage-init"]?.build;
      if (b) b.args = { SERVICE: "api" };
    });
    expect(() => composeBuilds(doc)).toThrow("two different ways");
  });
});

describe("matrix", () => {
  const builds = releaseBuilds(composeText);

  test("image × arch on native runners", () => {
    const m = buildMatrix(builds, parsePlatforms("linux/amd64,linux/arm64"));
    expect(m).toHaveLength(RELEASE_IMAGES.length * 2);
    expect(m.find((e) => e.image === "api" && e.arch === "arm64")).toEqual({
      image: "api",
      platform: "linux/arm64",
      arch: "arm64",
      runner: "ubuntu-24.04-arm",
    });
    expect(new Set(m.filter((e) => e.arch === "amd64").map((e) => e.runner))).toEqual(new Set(["ubuntu-24.04"]));
  });

  test("platforms are validated and ordered", () => {
    expect(parsePlatforms(" linux/arm64 , linux/amd64")).toEqual(["linux/amd64", "linux/arm64"]);
    expect(parsePlatforms("linux/amd64")).toEqual(["linux/amd64"]);
    expect(() => parsePlatforms("linux/riscv64")).toThrow("unsupported platform");
    expect(() => parsePlatforms("")).toThrow("no platforms");
  });
});

describe("buildArgv", () => {
  const builds = releaseBuilds(composeText);
  const opts = {
    platform: "linux/arm64" as const,
    version: "0.1.0-rc.1",
    commit: "c".repeat(40),
    source: "https://example.org/o/commonair",
    created: "2026-10-22T12:00:00+00:00",
    tag: "localhost/commonair/api:0.1.0-rc.1-arm64",
  };
  const flagValues = (argv: string[], flag: string) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));

  test("service images get compose's args plus SOURCE_COMMIT, never VERSION", () => {
    const api = builds.find((b) => b.image === "api")!;
    const argv = buildArgv(api, {
      ...opts,
      declared: declaredArgs(readFileSync(join(root, api.containerfile), "utf8")),
    });
    expect(argv.slice(0, 2)).toEqual(["podman", "build"]);
    expect(flagValues(argv, "--platform")).toEqual(["linux/arm64"]);
    expect(flagValues(argv, "--file")).toEqual(["infra/containers/service.Containerfile"]);
    expect(flagValues(argv, "--build-arg")).toEqual(["SERVICE=api", `SOURCE_COMMIT=${"c".repeat(40)}`]);
    expect(flagValues(argv, "--timestamp")).toEqual([String(Date.parse(opts.created) / 1000)]);
    expect(argv.at(-1)).toBe(".");
  });

  test("probe images pass the pinned base image through", () => {
    const loki = builds.find((b) => b.image === "loki")!;
    const argv = buildArgv(loki, {
      ...opts,
      declared: declaredArgs(readFileSync(join(root, loki.containerfile), "utf8")),
    });
    expect(flagValues(argv, "--build-arg")).toEqual([`BASE_IMAGE=${compose.services.loki?.build?.args?.BASE_IMAGE}`]);
  });

  test("the relay gets VERSION and builds in relay/", () => {
    const argv = buildArgv(RELAY_BUILD, {
      ...opts,
      declared: declaredArgs(readFileSync(join(root, "relay/Containerfile"), "utf8")),
    });
    expect(flagValues(argv, "--build-arg")).toEqual(["VERSION=0.1.0-rc.1"]);
    expect(flagValues(argv, "--file")).toEqual(["relay/Containerfile"]);
    expect(argv.at(-1)).toBe("relay");
  });

  test("OCI labels and annotations", () => {
    const argv = buildArgv(RELAY_BUILD, { ...opts, declared: new Set() });
    const want = [
      "org.opencontainers.image.source=https://example.org/o/commonair",
      `org.opencontainers.image.revision=${"c".repeat(40)}`,
      "org.opencontainers.image.version=0.1.0-rc.1",
      "org.opencontainers.image.licenses=AGPL-3.0-or-later",
      "org.opencontainers.image.created=2026-10-22T12:00:00Z",
    ];
    for (const w of want) {
      expect(flagValues(argv, "--label")).toContain(w);
      expect(flagValues(argv, "--annotation")).toContain(w);
    }
  });

  test("every release image declares its licenses; the created time is normalised to UTC", () => {
    expect(Object.keys(IMAGE_LICENSES).sort()).toEqual([...RELEASE_IMAGES].sort());
    expect(utcTimestamp("2026-10-22T11:02:37-04:00")).toBe("2026-10-22T15:02:37Z");
  });

  test("an invalid created time fails", () => {
    expect(() => buildArgv(RELAY_BUILD, { ...opts, created: "yesterday", declared: new Set() })).toThrow(
      "invalid created",
    );
  });
});

describe("declaredArgs", () => {
  test("finds ARG names, with or without defaults", () => {
    expect([...declaredArgs("ARG A\n  ARG B=1\nRUN echo ARG C\nARG D_2=x y\n")]).toEqual(["A", "B", "D_2"]);
  });
});
