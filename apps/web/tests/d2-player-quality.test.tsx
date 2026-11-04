// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D2-player (F5): the controller's quality pick. A manual pick is kept only for the hls.js
 * playlist it was made on: a reload (a new data-mode ceiling, a move) goes back to Auto, since
 * hls.js drops its manual level on `loadSource` and the new renditions may differ.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { dataModeCeilingBps } from "@commonair/contracts/enums";
import { FakeHls, fakeApi, playbackStart } from "./p2p-fakes.ts";

class LevelHls extends FakeHls {
  static override Events = { ...FakeHls.Events, MANIFEST_PARSED: "hlsManifestParsed" };
  levels: { bitrate: number; height: number; videoCodec?: string; width?: number; uri: string }[] = [];
  nextLevel = -1;
  autoLevelCapping = -1;
}

vi.mock("hls.js", () => ({ default: LevelHls }));

const { PlayerController } = await import("../src/player/controller.ts");

const LOW = dataModeCeilingBps(800);
const BEAT_MS = 700_000;

function token(extra: Record<string, unknown> = {}): string {
  const claims = { v: 1, sid: "s", cid: "c", path: "live/rivertide", src: "origin", iat: 1, exp: 2, ...extra };
  return `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`;
}

const LEVELS = [
  { bitrate: 1_400_000, height: 480, videoCodec: "avc1.64001e", width: 854, uri: "480p/index.m3u8" },
  { bitrate: 3_000_000, height: 720, videoCodec: "avc1.64001f", width: 1280, uri: "index.m3u8" },
];

beforeEach(() => {
  FakeHls.instances = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function session() {
  const s = playbackStart({ enabled: false });
  const t = token();
  const st = {
    ...s,
    token: t,
    playlistUrl: `https://play.example/hls/live/rivertide/index.m3u8?t=${t}`,
    renditions: ["source", "480p"],
    dataMode: null,
  };
  const f = fakeApi(st as unknown as ReturnType<typeof playbackStart>);
  const video = document.createElement("video");
  vi.spyOn(video, "canPlayType").mockReturnValue("");
  vi.spyOn(video, "play").mockResolvedValue(undefined);
  const c = new PlayerController({ channel: "rivertide", video, api: f.api, onState: () => undefined });
  await c.start();
  const hls = FakeHls.instances[0] as LevelHls;
  hls.levels = LEVELS;
  return { c, f, hls };
}

describe("quality pick", () => {
  it("a pick goes to hls.js; an index out of range is Auto", async () => {
    const { c, hls } = await session();
    expect(c.quality()).toBe(-1);
    c.setQuality(1);
    expect(c.quality()).toBe(1);
    expect(hls.nextLevel).toBe(1);
    c.setQuality(5);
    expect(c.quality()).toBe(-1);
    expect(hls.nextLevel).toBe(-1);
    await c.stop();
  });

  it("a reload on a new ceiling goes back to Auto", async () => {
    const { c, f, hls } = await session();
    c.setQuality(1);
    c.setDataMode(LOW);
    f.heartbeat.mockResolvedValueOnce({ ok: true, token: token({ dm: LOW }) });
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    expect(hls.loadSource).toHaveBeenCalledTimes(2);
    expect(c.quality()).toBe(-1);
    await c.stop();
  });
});
