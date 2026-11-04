// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 8 (B8-player, W3-dvr-relay request 8): the heartbeat's `dvrSwitchTo` moves a session's DVR
 * off a departed relay to the origin. While DVR plays, the source swaps at the current position
 * (never to live); a paused viewer is swapped silently and stays paused where they were.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import { swapDvrSource, type DvrSwapSeam } from "../src/player/dvr.ts";
import { heartbeatDvrSwitch } from "../src/player/heartbeat.ts";

const ORIGIN_DVR = "http://localhost:3003/dvr/0194f1c2-0000-7000-8000-000000000001/index.m3u8?t=origin-token";

describe("heartbeatDvrSwitch", () => {
  const playing = { hasGrant: true, playingDvr: true };

  it("a switch while DVR plays swaps the source; at the live edge only the grant moves", () => {
    expect(heartbeatDvrSwitch({ dvrSwitchTo: ORIGIN_DVR, dvrToken: "origin-token" }, playing)).toEqual({
      url: ORIGIN_DVR,
      token: "origin-token",
      swap: true,
    });
    expect(heartbeatDvrSwitch({ dvrSwitchTo: ORIGIN_DVR }, { hasGrant: true, playingDvr: false })).toEqual({
      url: ORIGIN_DVR,
      token: "origin-token",
      swap: false,
    });
  });

  it("the URL's token wins; the beat's dvrToken fills in for a URL without one", () => {
    const bare = ORIGIN_DVR.replace("?t=origin-token", "");
    expect(heartbeatDvrSwitch({ dvrSwitchTo: bare, dvrToken: "fresh" }, playing)?.token).toBe("fresh");
    expect(heartbeatDvrSwitch({ dvrSwitchTo: bare }, playing)?.token).toBeNull();
  });

  it("nothing on a throttled beat, without a switch, without a grant, or with a bad URL", () => {
    expect(heartbeatDvrSwitch({ dvrSwitchTo: ORIGIN_DVR, throttled: true }, playing)).toBeNull();
    expect(heartbeatDvrSwitch({ dvrToken: "x" }, playing)).toBeNull();
    expect(heartbeatDvrSwitch({ dvrSwitchTo: "" }, playing)).toBeNull();
    expect(heartbeatDvrSwitch({ dvrSwitchTo: ORIGIN_DVR }, { hasGrant: false, playingDvr: true })).toBeNull();
    expect(heartbeatDvrSwitch({ dvrSwitchTo: "not a url" }, playing)).toBeNull();
  });
});

/** A fake DVR player: the playhead advances with the clock while playing. */
function fakeSeam(opts: { at: number | null; paused: boolean; loads?: boolean; loadMs?: number; autoplays?: boolean }) {
  let clock = 1_800_000_000_000;
  const log: string[] = [];
  let paused = opts.paused;
  let head = opts.at;
  const seam: DvrSwapSeam = {
    playheadWallclock: () => (head === null ? null : new Date(head)),
    seekToWallclock: (t) => {
      log.push(`seek ${t.getTime()}`);
      head = t.getTime();
      return true;
    },
    loadDvr: async (url, { autoplay }) => {
      log.push(`load ${url} autoplay=${autoplay}`);
      clock += opts.loadMs ?? 0;
      // A new source starts at the new playlist's start (what hls.js and native do).
      if (head !== null) head = 0;
      if (autoplay) {
        log.push("play");
        paused = false;
      } else if (opts.autoplays) {
        // An element that plays a new source on its own.
        log.push("play");
        paused = false;
      }
      return opts.loads ?? true;
    },
    paused: () => paused,
    pause: () => {
      log.push("pause");
      paused = true;
    },
  };
  return { seam, log, now: () => clock, state: () => ({ paused, head }) };
}

describe("swapDvrSource", () => {
  const AT = 1_799_999_900_000;

  it("playing: lands at the position plus the load time, never at live", async () => {
    const f = fakeSeam({ at: AT, paused: false, loadMs: 700 });
    expect(await swapDvrSource(f.seam, ORIGIN_DVR, f.now)).toBe("swapped");
    expect(f.log).toEqual([`load ${ORIGIN_DVR} autoplay=true`, "play", `seek ${AT + 700}`]);
    expect(f.state()).toEqual({ paused: false, head: AT + 700 });
  });

  it("paused: swapped silently, same position, still paused", async () => {
    const f = fakeSeam({ at: AT, paused: true, loadMs: 700 });
    expect(await swapDvrSource(f.seam, ORIGIN_DVR, f.now)).toBe("swapped");
    // Never told to play, so nothing is heard and no pause is needed.
    expect(f.log).toEqual([`load ${ORIGIN_DVR} autoplay=false`, `seek ${AT}`]);
    expect(f.log).not.toContain("play");
    expect(f.state()).toEqual({ paused: true, head: AT });
  });

  it("paused, on an element that plays a new source anyway: paused again at the same position", async () => {
    const f = fakeSeam({ at: AT, paused: true, loadMs: 700, autoplays: true });
    expect(await swapDvrSource(f.seam, ORIGIN_DVR, f.now)).toBe("swapped");
    expect(f.log).toEqual([`load ${ORIGIN_DVR} autoplay=false`, "play", `seek ${AT}`, "pause"]);
    expect(f.state()).toEqual({ paused: true, head: AT });
  });

  it("a failed or superseded load does nothing more (the controller handles live)", async () => {
    const f = fakeSeam({ at: AT, paused: true, loads: false });
    expect(await swapDvrSource(f.seam, ORIGIN_DVR, f.now)).toBe("failed");
    expect(f.log).toEqual([`load ${ORIGIN_DVR} autoplay=false`]);
  });

  it("reports where it sent the playhead and whether the seek took, for the controller's landing guard", async () => {
    const f = fakeSeam({ at: AT, paused: false, loadMs: 700 });
    const landed = vi.fn<(t: Date, ok: boolean) => void>();
    expect(await swapDvrSource({ ...f.seam, landed }, ORIGIN_DVR, f.now)).toBe("swapped");
    expect(landed).toHaveBeenCalledWith(new Date(AT + 700), true);
    const g = fakeSeam({ at: AT, paused: true });
    const refused = vi.fn<(t: Date, ok: boolean) => void>();
    await swapDvrSource({ ...g.seam, seekToWallclock: () => false, landed: refused }, ORIGIN_DVR, g.now);
    expect(refused).toHaveBeenCalledWith(new Date(AT), false);
  });

  it("no known position: the new source plays, with no seek", async () => {
    const f = fakeSeam({ at: null, paused: false });
    expect(await swapDvrSource(f.seam, ORIGIN_DVR, f.now)).toBe("swapped");
    expect(f.log).toEqual([`load ${ORIGIN_DVR} autoplay=true`, "play"]);
  });
});
