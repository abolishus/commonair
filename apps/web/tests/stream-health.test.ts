// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { en } from "../src/i18n/en.ts";
import {
  HEALTH_WARNING_CODES,
  HEALTH_WARNING_KEYS,
  healthState,
  latestWarnings,
  pollWhileVisible,
  warningMessage,
  type PollEnv,
  type StreamHealthDto,
} from "../src/lib/stream-health.ts";

const RULES = new URL("../../../services/media/src/health/rules.ts", import.meta.url).pathname;

/** The string values of `export const WARNINGS = { … }` in the media rules. */
function mediaWarningCodes(): string[] {
  const text = readFileSync(RULES, "utf8");
  const body = text.split(/export const WARNINGS = \{/)[1]?.split(/\}\s*as const/)[0] ?? "";
  return [...body.matchAll(/^\s*\w+:\s*"([a-z0-9_]+)"/gm)].flatMap((m) => (m[1] ? [m[1]] : []));
}

type Sample = StreamHealthDto["samples"][number];
const sample = (at: string, warnings: string[]): Sample => ({
  at,
  bitrateKbps: 4000,
  fps: 30,
  width: 1280,
  height: 720,
  videoCodec: "h264",
  audioCodec: "aac",
  keyframeIntervalMs: 2000,
  droppedFrames: 0,
  warnings,
});

describe("health warning codes", () => {
  it("mirrors every code services/media can emit", () => {
    const media = mediaWarningCodes();
    expect(media.length).toBeGreaterThan(5);
    expect([...HEALTH_WARNING_CODES].sort()).toEqual([...media].sort());
  });

  it.each(HEALTH_WARNING_CODES)("%s has a title and a fix hint in the catalog", (code) => {
    const keys = HEALTH_WARNING_KEYS[code];
    expect(keys.title in en).toBe(true);
    expect(keys.hint in en).toBe(true);
    const msg = warningMessage(code);
    expect(msg.title.length).toBeGreaterThan(0);
    expect(msg.hint.length).toBeGreaterThan(0);
    expect(msg.title).not.toBe(msg.hint);
  });

  it("gives every code its own message", () => {
    const titles = HEALTH_WARNING_CODES.map((c) => warningMessage(c).title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("falls back to a generic message that names an unknown code", () => {
    const msg = warningMessage("brand_new_rule");
    expect(msg.title).toBe(en["health.unknown.title"]);
    expect(msg.hint).toContain("brand_new_rule");
    // Inherited object keys are not codes.
    expect(warningMessage("toString").title).toBe(en["health.unknown.title"]);
  });
});

describe("healthState / latestWarnings", () => {
  it("is offline when not live, whatever old samples say", () => {
    const h = { live: false, samples: [sample("2026-10-18T10:00:00Z", ["bitrate_low"])] };
    expect(healthState(h)).toBe("offline");
    expect(latestWarnings(h)).toEqual([]);
  });

  it("is healthy when live with no samples yet or a clean latest sample", () => {
    expect(healthState({ live: true, samples: [] })).toBe("healthy");
    const h = {
      live: true,
      samples: [sample("2026-10-18T10:00:00Z", ["fps_drop"]), sample("2026-10-18T10:00:10Z", [])],
    };
    expect(healthState(h)).toBe("healthy");
  });

  it("shows only the newest sample's warnings, deduplicated, regardless of order", () => {
    const h = {
      live: true,
      samples: [
        sample("2026-10-18T10:00:20Z", ["bitrate_low", "audio_missing", "bitrate_low"]),
        sample("2026-10-18T10:00:10Z", ["fps_drop"]),
      ],
    };
    expect(healthState(h)).toBe("warning");
    expect(latestWarnings(h)).toEqual(["bitrate_low", "audio_missing"]);
  });
});

function fakeEnv(visible: boolean) {
  const listeners = new Set<() => void>();
  const timers = new Map<number, () => void>();
  let next = 1;
  const env: PollEnv & { visible: boolean } = {
    visible,
    isVisible: () => env.visible,
    onVisibilityChange: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setInterval: (fn) => {
      timers.set(next, fn);
      return next++;
    },
    clearInterval: (h) => timers.delete(h as number),
  };
  return {
    env,
    timers,
    listeners,
    fire: () => {
      for (const fn of timers.values()) fn();
    },
    setVisible: (v: boolean) => {
      env.visible = v;
      for (const l of listeners) l();
    },
  };
}

describe("pollWhileVisible", () => {
  it("ticks at once and on every interval while visible", () => {
    const f = fakeEnv(true);
    let ticks = 0;
    pollWhileVisible(() => ticks++, 10_000, f.env);
    expect(ticks).toBe(1);
    f.fire();
    f.fire();
    expect(ticks).toBe(3);
    expect(f.timers.size).toBe(1);
  });

  it("stops while hidden and resumes with an immediate tick", () => {
    const f = fakeEnv(true);
    let ticks = 0;
    pollWhileVisible(() => ticks++, 10_000, f.env);
    f.setVisible(false);
    expect(f.timers.size).toBe(0);
    f.fire();
    expect(ticks).toBe(1);
    f.setVisible(true);
    expect(ticks).toBe(2);
    expect(f.timers.size).toBe(1);
    // A repeated "visible" event does not start a second interval.
    f.setVisible(true);
    expect(ticks).toBe(2);
    expect(f.timers.size).toBe(1);
  });

  it("does nothing until a hidden tab becomes visible", () => {
    const f = fakeEnv(false);
    let ticks = 0;
    pollWhileVisible(() => ticks++, 10_000, f.env);
    expect(ticks).toBe(0);
    expect(f.timers.size).toBe(0);
    f.setVisible(true);
    expect(ticks).toBe(1);
  });

  it("stop() clears the interval and the listener", () => {
    const f = fakeEnv(true);
    let ticks = 0;
    const stop = pollWhileVisible(() => ticks++, 10_000, f.env);
    stop();
    expect(f.timers.size).toBe(0);
    expect(f.listeners.size).toBe(0);
    f.setVisible(true);
    expect(ticks).toBe(1);
  });
});
