// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `giveaway` extension's pure helpers: the harness's own re-run of the draw, and refusal reasons. */
import { describe, expect, it } from "vite-plus/test";
import { commit, draw, newSeed } from "../../../packages/draw/src/index.ts";
import { reasonOf, rerunDraw, type Verification } from "../../src/w3/giveaways.ts";

const entries = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(64)).sort();

async function honest(winnerCount = 2): Promise<Verification> {
  const seed = newSeed();
  const order = await draw(seed, entries, entries.length);
  return {
    status: "drawn",
    seedCommitment: await commit(seed),
    seed,
    entries,
    winnerCount,
    winners: order
      .slice(0, winnerCount)
      .map((index, i) => ({ rank: i + 1, index, pseudonym: entries[index] as string })),
  };
}

describe("rerunDraw", () => {
  it("matches an honest draw, and one with a passed-over winner", async () => {
    expect(await rerunDraw(await honest())).toEqual([]);
    const v = await honest(1);
    const order = await draw(v.seed as string, entries, entries.length);
    const second = order[1] as number;
    const passedOver = [{ rank: 1, index: second, pseudonym: entries[second] as string }];
    expect(await rerunDraw({ ...v, winners: passedOver })).toEqual([]);
  });

  it("finds a wrong seed, an unsorted list, swapped winners, a wrong pseudonym and too many winners", async () => {
    const v = await honest();
    expect(await rerunDraw({ ...v, seed: newSeed() })).toContain("the seed does not hash to the commitment");
    expect(await rerunDraw({ ...v, entries: [...entries].reverse() })).toContain(
      "the entries are not sorted and unique",
    );
    const swapped = [...v.winners].reverse().map((w, i) => ({ ...w, rank: i + 1 }));
    expect((await rerunDraw({ ...v, winners: swapped })).length).toBeGreaterThan(0);
    const renamed = v.winners.map((w) => ({ ...w, pseudonym: "f".repeat(64) }));
    expect((await rerunDraw({ ...v, winners: renamed })).join()).toMatch(/another pseudonym/);
    expect((await rerunDraw({ ...v, winnerCount: 1 })).join()).toMatch(/2 winners for 1 places/);
    expect(await rerunDraw({ ...v, seed: null })).toEqual(["the seed is not revealed"]);
  });
});

describe("reasonOf", () => {
  it("reads data.reason of an oRPC error", () => {
    expect(reasonOf({ code: "FORBIDDEN", data: { reason: "verified_watch" } })).toBe("verified_watch");
    expect(reasonOf({ code: "FORBIDDEN" })).toBeNull();
    expect(reasonOf(new Error("x"))).toBeNull();
    expect(reasonOf(null)).toBeNull();
  });
});
