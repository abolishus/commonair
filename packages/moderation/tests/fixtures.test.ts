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
const digest = async () =>
  Promise.all(
    names.map(async (name) => {
      const data = await Bun.file(new URL(name, directory)).arrayBuffer();
      return createHash("sha256").update(new Uint8Array(data)).digest("hex");
    }),
  );

describe("synthetic fixture generator", () => {
  test("regenerating produces byte-identical images and fixture lists", async () => {
    const before = await digest();
    const script = new URL("../fixtures/generate.ts", import.meta.url).pathname;
    const run = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "ignore" });
    expect(await run.exited).toBe(0);
    expect(await digest()).toEqual(before);
  });
});
