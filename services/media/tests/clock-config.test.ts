// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * MediaMTX settings the media clock depends on (ADR 0012 A2): SRT serves internal readers, and
 * only the rendition paths stamp PDT from their publisher's sender reports. The ingest path must
 * never do so (decision 1: a streamer must not be able to move media time). The harness's
 * throwaway MediaMTX mirrors the rendition setting.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { mediamtxConfig } from "../../../harness/src/testing/mediamtx.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

type Yaml = Record<string, unknown>;
const prod = Bun.YAML.parse(readFileSync(join(REPO_ROOT, "infra/mediamtx/mediamtx.yml"), "utf8")) as Yaml;
const harness = Bun.YAML.parse(mediamtxConfig({ webrtcUdpPort: 18189 })) as Yaml;

const RENDITIONS = "~^live/[a-z0-9_]{3,25}/(1080p|720p|480p|audio|aac)$";
const INGEST = "~^live/[a-z0-9_]{3,25}$";
const paths = (c: Yaml) => c.paths as Record<string, Yaml | null>;

describe("production MediaMTX config", () => {
  test("SRT is on, on :8890", () => {
    expect(prod.srt).toBe(true);
    expect(prod.srtAddress).toBe(":8890");
  });

  test("useAbsoluteTimestamp on the rendition block only", () => {
    expect(paths(prod)[RENDITIONS]?.useAbsoluteTimestamp).toBe(true);
    expect(paths(prod)[INGEST]).toBeTruthy();
    expect(paths(prod)[INGEST]).not.toHaveProperty("useAbsoluteTimestamp");
    expect(prod.pathDefaults).not.toHaveProperty("useAbsoluteTimestamp");
    const others = Object.entries(paths(prod)).filter(([k]) => k !== RENDITIONS);
    for (const [, block] of others) expect(block ?? {}).not.toHaveProperty("useAbsoluteTimestamp");
  });

  test("the SRT port is documented as internal", () => {
    expect(readFileSync(join(REPO_ROOT, "infra/mediamtx/mediamtx.yml"), "utf8")).toMatch(
      /8890\/udp\s+SRT \(internal\)/,
    );
  });
});

describe("harness MediaMTX config", () => {
  // The harness writes YAML 1.1 booleans (`yes`), which MediaMTX accepts; Bun.YAML reads 1.2.
  test("mirrors SRT and the rendition block's absolute timestamps", () => {
    expect([true, "yes"]).toContain(harness.srt);
    expect(harness.srtAddress).toBe(":8890");
    expect([true, "yes"]).toContain(paths(harness)[RENDITIONS]?.useAbsoluteTimestamp);
    expect(paths(harness).all_others ?? {}).not.toHaveProperty("useAbsoluteTimestamp");
    // The rendition block must come before the catch-all to match first.
    const order = Object.keys(paths(harness));
    expect(order.indexOf(RENDITIONS)).toBeLessThan(order.indexOf("all_others"));
  });
});
