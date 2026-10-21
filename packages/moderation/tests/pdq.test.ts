// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * PDQ port against ThreatExchange's own regression output (tests/vectors/expected.txt, tag
 * hma-v1.1.7). Exactness needs the input decoded the way upstream decodes it:
 * `vectors/decoded/bridge-1-original.512.rgb.gz` is bridge-1-original.jpg decoded by libjpeg
 * (`djpeg -ppm`, ISLOW DCT, fancy upsampling) and resized to 512×512 with CImg's nearest-neighbour
 * rule, exactly as `pdq-photo-hasher` does (see vectors/make-decoded.ts). It goes through the
 * reference RGB → luma conversion (`pdqHashRgb`). The ffmpeg decode path is checked with a
 * Hamming tolerance in frames.int.test.ts.
 */
import { describe, expect, test } from "vite-plus/test";
import { MODERATION_CONSTANTS } from "../src/constants.ts";
import { hammingDistance, hashWords, pdqHash, pdqHashRgb, popcount32 } from "../src/pdq.ts";
import { computeJaroszFilterWindowSize, decimateFloat } from "../src/pdq/downscaling.ts";
import { floatLumaFromRGB, formatHash256, pdqDihedralHash256esFromFloatLuma, torben } from "../src/pdq/hashing.ts";

const vectors = new URL("./vectors/", import.meta.url).pathname;

async function expected() {
  const text = await Bun.file(`${vectors}expected.txt`).text();
  return text
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => {
      const [hash, second, file] = l.split(",") as [string, string, string];
      return { hash, second, file };
    });
}

async function decodedBridge1() {
  const gz = new Uint8Array(await Bun.file(`${vectors}decoded/bridge-1-original.512.rgb.gz`).arrayBuffer());
  return Bun.gunzipSync(gz);
}

describe("PDQ reference vectors (exact)", () => {
  test("bridge-1-original: hash and quality equal upstream's pdq-photo-hasher output", async () => {
    const rgb = await decodedBridge1();
    expect(rgb.length).toBe(512 * 512 * 3);
    const want = (await expected()).find((e) => e.file === "bridge-1-original.jpg" && e.second === "100");
    const got = pdqHashRgb(rgb, 512, 512);
    expect(got.hash).toBe(want?.hash);
    expect(got.quality).toBe(100);
  });

  test("bridge-1-original: all eight dihedral hashes equal upstream's --pdqdih output", async () => {
    const rgb = await decodedBridge1();
    const luma = floatLumaFromRGB(rgb, 512, 512);
    const { hashes, quality } = pdqDihedralHash256esFromFloatLuma(luma, new Float32Array(luma.length), 512, 512);
    expect(quality).toBe(100);
    const rows = (await expected()).filter((e) => e.second !== "100");
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(formatHash256(hashes[row.second as keyof typeof hashes])).toBe(row.hash);
  });

  test("published hashes of the eight transformed photos are self-consistent (upstream deltas)", async () => {
    const rows = (await expected()).filter((e) => e.second === "100");
    const orig = rows[0]?.hash ?? "";
    // Hamming distances derived from the published hashes for bridge-2..8 against bridge-1.
    const deltas = [118, 124, 124, 122, 128, 110, 126];
    expect(rows.slice(1).map((r) => hammingDistance(orig, r.hash))).toEqual(deltas);
  });
});

describe("hammingDistance", () => {
  const zero = "0".repeat(64);
  const ones = "f".repeat(64);
  test("identical, complement, single bits", () => {
    expect(hammingDistance(zero, zero)).toBe(0);
    expect(hammingDistance(zero, ones)).toBe(256);
    expect(hammingDistance(zero, `${"0".repeat(63)}1`)).toBe(1);
    expect(hammingDistance(zero, `8${"0".repeat(63)}`)).toBe(1);
    expect(hammingDistance(ones, `7${"f".repeat(63)}`)).toBe(1);
    expect(hammingDistance(`${"a".repeat(64)}`, `${"5".repeat(64)}`)).toBe(256);
  });
  test("symmetric", () => {
    const a = "d8f8f0cee0f4a84f0637022a078f67f0b36e2ed596621e1d33e6339c4e9c9b22";
    const b = "30a10efdf1c83f429013d48d0ffffc52e34e0e35ada952a9d29605215aa9e5af";
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
    expect(hammingDistance(a, b)).toBe(118);
  });
  test("throws on malformed input", () => {
    expect(() => hammingDistance(zero, "0".repeat(63))).toThrow("pdq: malformed hash");
    expect(() => hammingDistance(zero, "0".repeat(65))).toThrow("pdq: malformed hash");
    expect(() => hammingDistance(zero, "F".repeat(64))).toThrow("pdq: malformed hash");
    expect(() => hammingDistance(zero, `g${"0".repeat(63)}`)).toThrow("pdq: malformed hash");
    expect(() => hammingDistance("", "")).toThrow("pdq: malformed hash");
  });
  test("popcount32 and hashWords", () => {
    expect(popcount32(0)).toBe(0);
    expect(popcount32(0xffffffff)).toBe(32);
    expect(popcount32(0x80000001)).toBe(2);
    expect(Array.from(hashWords(`${"0".repeat(56)}ffffffff`))).toEqual([0, 0, 0, 0, 0, 0, 0, 0xffffffff]);
  });
});

describe("quality", () => {
  test("uniform frames (black, white, grey) have quality 0", () => {
    expect(pdqHash(new Uint8Array(512 * 512), 512, 512).quality).toBeLessThan(50);
    for (const v of [0, 128, 255]) expect(pdqHash(new Uint8Array(512 * 512).fill(v), 512, 512).quality).toBe(0);
  });
  test("near-uniform frames stay below the matching floor", () => {
    // Faint noise of ±2 levels and a gentle gradient are what fades and dark scenes look like.
    let s = 1;
    const noise = new Uint8Array(512 * 512).map(() => {
      s = (s * 1103515245 + 12345) >>> 0;
      return 16 + ((s >>> 16) % 5);
    });
    expect(pdqHash(noise, 512, 512).quality).toBeLessThan(MODERATION_CONSTANTS.PDQ_MIN_QUALITY);
    const ramp = new Uint8Array(512 * 512).map((_, i) => Math.floor((i % 512) / 16));
    expect(pdqHash(ramp, 512, 512).quality).toBeLessThan(MODERATION_CONSTANTS.PDQ_MIN_QUALITY);
  });
  test("strong structure saturates at 100", () => {
    const board = new Uint8Array(512 * 512).map((_, i) => ((((i % 512) >> 5) + ((i >> 9) >> 5)) & 1 ? 255 : 0));
    expect(pdqHash(board, 512, 512).quality).toBe(100);
  });
});

describe("pdqHash input handling", () => {
  test("images smaller than 5 px hash to zero with quality 0", () => {
    expect(pdqHash(new Uint8Array(16).fill(200), 4, 4)).toEqual({ hash: "0".repeat(64), quality: 0 });
    expect(pdqHash(new Uint8Array(0), 0, 0)).toEqual({ hash: "0".repeat(64), quality: 0 });
  });
  test("rejects buffers that do not match the dimensions", () => {
    expect(() => pdqHash(new Uint8Array(10), 4, 4)).toThrow(RangeError);
    expect(() => pdqHashRgb(new Uint8Array(16), 4, 4)).toThrow(RangeError);
    expect(() => pdqHash(new Uint8Array(16), 4.5, 4)).toThrow(RangeError);
  });
  test("deterministic, lowercase 64-hex", () => {
    const img = new Uint8Array(300 * 200).map((_, i) => (i * 7919) % 251);
    const a = pdqHash(img, 300, 200);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(pdqHash(img, 300, 200)).toEqual(a);
  });
  test("a 64×64 input skips the filter (reference shortcut) and still hashes", () => {
    const img = new Uint8Array(64 * 64).map((_, i) => (i % 64 < 32 !== i < 2048 ? 255 : 0));
    const h = pdqHash(img, 64, 64);
    expect(h.quality).toBeGreaterThan(0);
    // Half the bits are above the median by construction.
    expect(hammingDistance(h.hash, "0".repeat(64))).toBeLessThanOrEqual(128);
  });
  test("a scaled copy hashes close to the original", () => {
    const big = new Uint8Array(512 * 512).map((_, i) => {
      const x = i % 512;
      const y = i >> 9;
      return (x - 200) ** 2 + (y - 300) ** 2 < 120 ** 2 || (x > 380 && y < 150) ? 230 : 20;
    });
    const small = new Uint8Array(256 * 256).map((_, i) => big[(i >> 8) * 2 * 512 + (i % 256) * 2] ?? 0);
    expect(hammingDistance(pdqHash(big, 512, 512).hash, pdqHash(small, 256, 256).hash)).toBeLessThanOrEqual(16);
  });
});

describe("downscaling and median helpers", () => {
  test("Jarosz window sizes (round up, half per pass)", () => {
    expect(computeJaroszFilterWindowSize(1024, 64)).toBe(8);
    expect(computeJaroszFilterWindowSize(512, 64)).toBe(4);
    expect(computeJaroszFilterWindowSize(513, 64)).toBe(5);
    expect(computeJaroszFilterWindowSize(64, 64)).toBe(1);
  });
  test("decimate samples target centers", () => {
    const input = Float32Array.from({ length: 16 }, (_, i) => i);
    const out = new Float32Array(4);
    decimateFloat(input, 4, 4, out, 2, 2);
    expect(Array.from(out)).toEqual([5, 7, 13, 15]);
  });
  test("torben median", () => {
    expect(torben(Float32Array.from([3, 1, 2]), 3)).toBe(2);
    expect(torben(Float32Array.from([4, 1, 3, 2]), 4)).toBe(2);
    expect(torben(Float32Array.from([5, 5, 5, 5]), 4)).toBe(5);
  });
});
