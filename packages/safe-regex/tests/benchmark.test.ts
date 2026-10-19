// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Benchmark-style check of the cost model: every pattern the validator accepts from a generated
 * adversarial corpus must stay fast on worst-case 500-character messages. This is the evidence
 * that an accepted filter cannot stall chat; chat's filter worker adds a hard timeout on top.
 */
import { describe, expect, test } from "vite-plus/test";
import { MAX_INPUT_LENGTH, unsafeFilterRegexReason } from "../src/index.ts";

/** Per pattern and input, after one warm-up run (the first run includes JIT compilation). */
const LIMIT_MS = 5;

/** mulberry32: a tiny seeded PRNG, so the corpus is the same on every run. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ATOMS = [
  ".",
  "\\w",
  "\\W",
  "\\s",
  "\\S",
  "\\d",
  "a",
  "b",
  "!",
  "[a-z]",
  "[^x]",
  "[^\\s]",
  "(?:a|b)",
  "(?:ab|ac)",
  "(?:a|a)",
  "(?:a|ab)",
  // Nested groups, also inside repeats.
  "(?:(?:a|\\w))",
  "(?:(?:ab|a)b)",
  "(?:(?:a|b)c|d)",
  "(?:(?:a|[ab])(?:a|[ab])|c)",
  "(?:x(?:a|\\w)|!)",
  "(?:a\\w?|b)",
  "\\u212A",
  "ſ",
  "k",
  "\\p{L}",
];
const QUANTIFIERS = ["", "", "", "*", "+", "?", "{0,20}", "{1,20}", "{2,}", "{0,5}", "+?"];
const alt = (p: string, n: number) => Array<string>(n).fill(p).join("|");

function corpus(): string[] {
  const rand = rng(0xc0ffee);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const seq = () => {
    const n = 1 + Math.floor(rand() * 5);
    let s = rand() < 0.15 ? "\\b" : "";
    for (let i = 0; i < n; i++) s += pick(ATOMS) + pick(QUANTIFIERS);
    return s + (rand() < 0.5 ? "!" : "");
  };
  const out = new Set<string>([
    alt(".*.{0,20}!", 18),
    alt(".*!", 4),
    alt("\\w+!", 4),
    alt("a\\w*b", 4),
    "a?a?a?a?a?a?a?a?a?a?aaaaa!",
    "[^\\s]+\\.(?:ru|xyz)\\b",
    "\\w+\\s+\\w+\\s+\\w+!",
    "f+u+c+k+e+r+",
    "f.{0,3}u.{0,3}c.{0,3}k",
    "(?:a|a)(?:a|a)(?:a|a)(?:a|a)(?:a|a)(?:a|a)(?:a|a)(?:a|a)(?:a|a)(?:a|a)!",
  ]);
  for (let i = 0; i < 1500; i++) {
    const r = rand();
    if (r < 0.6) out.add(seq());
    else if (r < 0.8) out.add(alt(seq(), 2 + Math.floor(rand() * 17)));
    else out.add(Array.from({ length: 2 + Math.floor(rand() * 8) }, seq).join("|"));
  }
  return [...out];
}

/** Single characters and two-character cycles over an alphabet that hits every atom above. */
function hostileInputs(): string[] {
  const alphabet = ["a", "b", "!", " ", "x", "1", "é", "K", "s", "\n"];
  const inputs: string[] = [];
  for (const a of alphabet) {
    inputs.push(a.repeat(MAX_INPUT_LENGTH));
    for (const b of alphabet) if (a !== b) inputs.push((a + b).repeat(MAX_INPUT_LENGTH / 2));
  }
  inputs.push("a".repeat(MAX_INPUT_LENGTH - 1) + "x", "ab".repeat(240) + "a.".repeat(10), "aaaa!".repeat(100));
  return inputs;
}

function slowest(re: RegExp, inputs: readonly string[]): { ms: number; input: string } {
  let worst = { ms: 0, input: "" };
  for (const s of inputs) {
    re.lastIndex = 0;
    re.test(s);
    // Best of a few runs, with more retries when a run looks slow: preemption by other test
    // workers inflates single samples, never the minimum.
    let best = Infinity;
    for (let i = 0; i < 2 || (best >= LIMIT_MS / 2 && i < 12); i++) {
      re.lastIndex = 0;
      const started = performance.now();
      re.test(s);
      best = Math.min(best, performance.now() - started);
    }
    if (best > worst.ms) worst = { ms: best, input: s };
  }
  return worst;
}

describe("cost model benchmark", () => {
  test("the review's .*.{0,20}! ×18 case is refused", () => {
    expect(unsafeFilterRegexReason(alt(".*.{0,20}!", 18))).not.toBeNull();
  });

  test(
    `every accepted pattern of the adversarial corpus runs in < ${LIMIT_MS} ms on a ${MAX_INPUT_LENGTH}-char message`,
    { timeout: 120_000 },
    () => {
      const inputs = hostileInputs();
      const patterns = corpus();
      const accepted = patterns.filter((p) => unsafeFilterRegexReason(p) === null);
      // The corpus must exercise both sides of the model.
      expect(accepted.length).toBeGreaterThan(200);
      expect(patterns.length - accepted.length).toBeGreaterThan(200);
      const slow: string[] = [];
      let max = 0;
      for (const p of accepted) {
        const { ms, input } = slowest(new RegExp(p, "giu"), inputs);
        max = Math.max(max, ms);
        if (ms >= LIMIT_MS) slow.push(`${p} on ${JSON.stringify(input.slice(0, 12))}…: ${ms.toFixed(2)} ms`);
      }
      if (process.env.SAFE_REGEX_BENCH)
        process.stderr.write(`${accepted.length}/${patterns.length} accepted, slowest ${max.toFixed(2)} ms\n`);
      expect(slow).toEqual([]);
    },
  );
});
