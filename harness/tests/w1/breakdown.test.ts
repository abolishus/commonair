// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The breakdown extension's pure checks (src/w1/breakdown.ts). */
import { describe, expect, test } from "vite-plus/test";
import {
  breakdownProblems,
  dialogViewOf,
  expectedCoopNet,
  grossSide,
  sameView,
  settledByBreakdown,
} from "../../src/w1/breakdown.ts";

type Kind = "tax" | "creator" | "coop_share" | "processor_fee" | "coop_net" | "reversal" | "dispute_fee";
type Component = "tax" | "creator" | "coop_share" | null;
const usd = (cents: number) => ({ cents, currency: "usd" });
const TX1 = "0192f000-0000-7000-8000-0000000000b1";
const TX2 = "0192f000-0000-7000-8000-0000000000b2";
const line = (kind: Kind, cents: number, transactionId: string | null, component: Component = null) => ({
  kind,
  amount: usd(cents),
  recipientUserId: null,
  component,
  transactionId,
});

/** A 10.00 tip with a 0.59 fee, charged back by 4.00 with a 15.00 dispute fee. */
function breakdown() {
  return {
    gross: usd(1000),
    lines: [
      line("creator", 900, TX1),
      line("coop_share", 100, TX1),
      line("processor_fee", 59, TX1),
      line("reversal", -360, TX2, "creator"),
      line("reversal", -40, TX2, "coop_share"),
      line("dispute_fee", 1500, TX2),
      line("coop_net", 100 - 40 - 59 - 1500, null),
    ],
    timeline: [
      { kind: "paid" as const, at: "2026-10-01T00:00:00.000Z", amount: usd(1000), transactionId: TX1 },
      { kind: "charged_back" as const, at: "2026-10-02T00:00:00.000Z", amount: usd(-400), transactionId: TX2 },
    ],
  };
}

describe("breakdown checks", () => {
  test("a consistent breakdown has no problems", () => {
    const b = breakdown();
    expect(breakdownProblems(b)).toEqual([]);
    expect(grossSide(b.lines)).toBe(1000);
    expect(expectedCoopNet(b.lines)).toBe(-1499);
    expect(settledByBreakdown(b.lines)).toBe(1000 - 400 - 59 - 1500);
  });

  test("gross-side, reversal and coop_net errors are each reported", () => {
    const b = breakdown();
    b.lines[0] = line("creator", 899, TX1);
    b.lines[3] = line("reversal", -361, TX2, "creator");
    b.lines[6] = line("coop_net", 0, null);
    const problems = breakdownProblems(b);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/gross-side lines sum to 999/);
    expect(problems[1]).toMatch(/charged_back .* sum to -401, not -400/);
    expect(problems[2]).toMatch(/coop_net 0, by definition -1499/);
  });

  test("a negative fee, a reversal without component and a missing coop_net are reported", () => {
    const b = breakdown();
    b.lines[2] = line("processor_fee", -1, TX1);
    b.lines[4] = line("reversal", -40, TX2, null);
    b.lines.pop();
    const problems = breakdownProblems(b);
    expect(problems).toContain("negative processor fee -1");
    expect(problems).toContain("a reversal line without its component");
    expect(problems).toContain("0 coop_net lines");
  });

  test("a returned dispute fee counts back for the co-op", () => {
    const lines = [
      line("coop_share", 100, TX1),
      line("dispute_fee", 1500, TX2),
      line("dispute_fee", -1500, TX2),
      line("reversal", 40, TX2, "coop_share"),
    ];
    expect(expectedCoopNet(lines)).toBe(140);
    expect(settledByBreakdown(lines)).toBe(140);
  });

  test("the dialog view compares gross and every line in order", () => {
    const view = dialogViewOf(breakdown());
    expect(view.grossCents).toBe(1000);
    expect(view.lines[3]).toEqual({ kind: "reversal", component: "creator", cents: -360 });
    expect(sameView(view, dialogViewOf(breakdown()))).toBe(true);
    expect(sameView(view, { ...view, lines: [...view.lines].reverse() })).toBe(false);
    expect(sameView(view, { ...view, grossCents: 999 })).toBe(false);
  });
});
