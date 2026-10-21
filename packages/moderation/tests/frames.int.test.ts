// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, describe, expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeImage, sampleVideoFrames } from "../src/frames.ts";
import { parseHashList, createHashMatcher } from "../src/hashlist.ts";
import { pdqHash } from "../src/pdq.ts";

const dir = await mkdtemp(join(tmpdir(), "moderation-synthetic-"));
afterAll(async () => rm(dir, { recursive: true, force: true }));
const bytes = async (name: string) =>
  new Uint8Array(await Bun.file(new URL(`../fixtures/${name}.png`, import.meta.url)).arrayBuffer());

describe("ffmpeg moderation path", () => {
  test("synthetic patterns decode and distinguish the two fixture lists", async () => {
    const csamList = parseHashList(await Bun.file(new URL("../fixtures/csam.pdq", import.meta.url)).text(), "csam");
    const nciiList = parseHashList(await Bun.file(new URL("../fixtures/ncii.pdq", import.meta.url)).text(), "ncii");
    const matcher = createHashMatcher([csamList, nciiList]);
    const a = pdqHash((await decodeImage(await bytes("t0-pattern"))).luma, 512, 512);
    const b = pdqHash((await decodeImage(await bytes("t0-ncii-pattern"))).luma, 512, 512);
    expect(matcher.match(a)?.category).toBe("csam");
    expect(matcher.match(b)?.category).toBe("ncii");
    for (const name of ["benign-gradient", "benign-checkerboard", "benign-noise"]) {
      const h = pdqHash((await decodeImage(await bytes(name))).luma, 512, 512);
      expect(matcher.match(h)).toBeNull();
    }
  });
  test("synthetic CSAM-list fixture survives H.264 encode and frame sampling", async () => {
    const source = await bytes("t0-pattern");
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-loop",
        "1",
        "-framerate",
        "2",
        "-f",
        "image2pipe",
        "-i",
        "pipe:0",
        "-t",
        "3",
        "-vf",
        "fps=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        join(dir, "synthetic.mp4"),
      ],
      { stdin: "pipe", stdout: "ignore", stderr: "ignore" },
    );
    await proc.stdin.write(source);
    await proc.stdin.end();
    expect(await proc.exited).toBe(0);
    const list = parseHashList(await Bun.file(new URL("../fixtures/csam.pdq", import.meta.url)).text(), "csam");
    const matcher = createHashMatcher([list]);
    let count = 0;
    for await (const frame of sampleVideoFrames(join(dir, "synthetic.mp4"), { everySeconds: 1 })) {
      const h = pdqHash(frame.luma, 512, 512);
      expect(h.quality).toBeGreaterThanOrEqual(50);
      expect(matcher.match(h)?.category).toBe("csam");
      count++;
    }
    expect(count).toBeGreaterThan(0);
  });
});
