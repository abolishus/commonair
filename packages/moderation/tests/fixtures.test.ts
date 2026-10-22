// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import process from "node:process";
import { describe, expect, test } from "vite-plus/test";

const directory = new URL("../fixtures/", import.meta.url);
const names = [
  "t0-pattern.png",
  "t0-ncii-pattern.png",
  "benign-gradient.png",
  "benign-checkerboard.png",
  "benign-noise.png",
  "csam.pdq",
  "ncii.pdq",
];
/**
 * PNGs by their decoded pixels, hash lists by their bytes. ffmpeg's PNG encoder output depends
 * on its build (zlib), so the same pixels encode to different bytes on a Linux runner than on a
 * workstation; the images and the PDQ lists are what must not change.
 */
const pixels = (file: string) => {
  const r = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  if (r.exitCode !== 0) throw new Error(`ffmpeg could not decode ${file}: ${r.stderr.toString()}`);
  return r.stdout;
};
const digest = async () =>
  Promise.all(
    names.map(async (name) => {
      const file = new URL(name, directory).pathname;
      const data = name.endsWith(".png") ? pixels(file) : new Uint8Array(await Bun.file(file).arrayBuffer());
      return createHash("sha256").update(data).digest("hex");
    }),
  );

describe("synthetic fixture generator", () => {
  test("regenerating produces pixel-identical images and byte-identical fixture lists", async () => {
    const before = await digest();
    const script = new URL("../fixtures/generate.ts", import.meta.url).pathname;
    const run = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "ignore" });
    expect(await run.exited).toBe(0);
    expect(await digest()).toEqual(before);
  });
});
