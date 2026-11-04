// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { StreamerError, ingestRefusal, retryRefusedPublish } from "../src/streamer.ts";

const URL = "rtmp://localhost:1935/live/chan?key=live_abc";

// The stderr tails of the three CI failures (runs 41793894751, 41827726573: Podman DNS stalled on
// the auth hook's `api` lookup; 41817862390: the hook timed out).
const AUTH_FAILED = [
  "[rtmp @ 0x559adc20ca40] Server error: authentication failed",
  `[out#0/flv @ 0x559adc207ac0] Error opening output ${URL}: Operation not permitted`,
  `Error opening output file ${URL}.`,
  "Error opening output files: Operation not permitted",
];
const HOOK_TIMEOUT = [
  `[out#0/flv @ 0x5632d1f9dcc0] Error opening output ${URL}: Input/output error`,
  `Error opening output file ${URL}.`,
  "Error opening output files: Input/output error",
];
const NO_FONT = [
  "[Parsed_drawtext_1 @ 0x55] Cannot find a valid font for the family Sans",
  "[AVFilterGraph @ 0x55] Error initializing filters",
  "Error opening output files: Operation not permitted",
];

const refused = (stderr = AUTH_FAILED) =>
  new StreamerError("ffmpeg exited with code 255 before publishing", stderr, 255);

describe("ingestRefusal", () => {
  test("names an auth refusal", () => {
    expect(ingestRefusal(AUTH_FAILED)).toBe("authentication failed");
  });

  test("names a dropped connection to the ingest URL", () => {
    expect(ingestRefusal(HOOK_TIMEOUT)).toBe("Input/output error");
    expect(ingestRefusal([`Error opening output ${URL}: Connection refused`])).toBe("Connection refused");
  });

  test("ignores filter, font and encoder failures", () => {
    expect(ingestRefusal(NO_FONT)).toBeNull();
    expect(ingestRefusal(["Unknown encoder 'libx264'"])).toBeNull();
    expect(ingestRefusal([`Error opening output ${URL}: Invalid argument`])).toBeNull();
    expect(ingestRefusal([])).toBeNull();
  });
});

describe("retryRefusedPublish", () => {
  const noWait = async () => undefined;

  test("publishes on a later attempt after refusals, backing off and reporting each", async () => {
    const waits: number[] = [];
    const retries: [number, string][] = [];
    let calls = 0;
    await retryRefusedPublish(
      async () => {
        calls++;
        if (calls === 1) throw refused();
        if (calls === 2) throw refused(HOOK_TIMEOUT);
      },
      {
        attempts: 3,
        backoffMs: 1_500,
        sleep: async (ms) => void waits.push(ms),
        onRetry: (attempt, reason) => void retries.push([attempt, reason]),
      },
    );
    expect(calls).toBe(3);
    expect(waits).toEqual([1_500, 3_000]);
    expect(retries).toEqual([
      [1, "authentication failed"],
      [2, "Input/output error"],
    ]);
  });

  test("a publish refused every time (a wrong key) still fails, with the last error", async () => {
    let calls = 0;
    const last = refused();
    const run = retryRefusedPublish(
      async () => {
        calls++;
        throw calls === 3 ? last : refused();
      },
      { attempts: 3, backoffMs: 1, sleep: noWait },
    );
    await expect(run).rejects.toBe(last);
    expect(calls).toBe(3);
  });

  test("does not retry other failures", async () => {
    for (const err of [
      new StreamerError("ffmpeg exited with code 1 before publishing", NO_FONT, 1),
      // Timed out waiting for frames: no exit code, so not a refusal at connect.
      new StreamerError("first frames timed out", AUTH_FAILED, null),
      new Error("spawn ffmpeg ENOENT"),
    ]) {
      let calls = 0;
      const run = retryRefusedPublish(
        async () => {
          calls++;
          throw err;
        },
        { attempts: 3, backoffMs: 1, sleep: noWait },
      );
      await expect(run).rejects.toBe(err);
      expect(calls).toBe(1);
    }
  });

  test("attempts: 1 never retries", async () => {
    let calls = 0;
    const run = retryRefusedPublish(
      async () => {
        calls++;
        throw refused();
      },
      { attempts: 1, backoffMs: 1, sleep: noWait },
    );
    await expect(run).rejects.toBeInstanceOf(StreamerError);
    expect(calls).toBe(1);
  });
});
