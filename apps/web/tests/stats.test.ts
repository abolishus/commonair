// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import { VideoStats } from "../src/player/stats.ts";

class FakeVideo extends EventTarget {
  currentTime = 0;
  paused = false;
  buffered = { length: 1, end: () => 14 };
  at(time: number, type = "timeupdate"): void {
    this.currentTime = time;
    this.dispatchEvent(new Event(type));
  }
}

function setup() {
  const video = new FakeVideo();
  let now = 1_000;
  let firstFrames = 0;
  const stats = new VideoStats(
    video as unknown as HTMLVideoElement,
    () => firstFrames++,
    () => now,
  );
  return { video, stats, tick: (ms: number) => (now += ms), firstFrames: () => firstFrames };
}

describe("VideoStats", () => {
  it("measures time to first frame once", () => {
    const s = setup();
    s.tick(1_500);
    s.video.at(0); // still at zero: no frame yet
    expect(s.stats.ttffMs).toBeNull();
    s.video.at(0.04);
    expect(s.stats.ttffMs).toBe(1_500);
    s.tick(500);
    s.video.at(0.5);
    expect(s.stats.ttffMs).toBe(1_500);
    expect(s.firstFrames()).toBe(1);
  });

  it("accumulates played time and ignores seeks, jumps and paused ticks", () => {
    const s = setup();
    s.video.at(10);
    s.video.at(10.25);
    s.video.at(10.5);
    s.video.at(30); // live-edge jump
    s.video.at(30.5);
    s.video.paused = true;
    s.video.at(31);
    s.video.paused = false;
    s.video.dispatchEvent(new Event("seeking"));
    s.video.at(40);
    s.video.at(40.25);
    expect(s.stats.playedSeconds).toBeCloseTo(0.5 + 0.5 + 0.25);
  });

  it("counts stalls only after the first frame", () => {
    const s = setup();
    s.video.dispatchEvent(new Event("waiting"));
    s.video.at(1);
    s.video.dispatchEvent(new Event("waiting"));
    s.video.dispatchEvent(new Event("waiting"));
    expect(s.stats.stalls).toBe(2);
  });

  it("reports buffer ahead of the playhead and stops listening on dispose", () => {
    const s = setup();
    s.video.at(10);
    expect(s.stats.bufferSeconds()).toBe(4);
    s.stats.dispose();
    s.video.at(10.5);
    expect(s.stats.playedSeconds).toBe(0);
  });
});
