// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The enforcement report's pure parts (batch 6 decision (d)): k = 10 suppression with
 * complementary suppression, the overturn denominator, windows at 00:00 UTC, the rule-ref
 * helpers and the request locale.
 */
import { describe, expect, test } from "vite-plus/test";
import { EnforcementReport } from "@commonair/contracts/dto";
import {
  assemble,
  cell,
  clauseTitleIn,
  forcedBy,
  mergeCells,
  partsOf,
  publishCell,
  publishNcii,
  tierOfSource,
  totalOver,
  windowBounds,
  type Cell,
} from "../src/transparency/enforcement.ts";
import { acceptLanguageTags, requestLocale } from "../src/transparency/locale.ts";
import {
  caseDecisionRuleRef,
  caseRuleRefAfter,
  reportReasonRuleRef,
  staffRuleRef,
} from "../src/transparency/rule-ref.ts";

const S = { suppressed: true } as const;
const v = (value: number) => ({ suppressed: false, value });

const base: Cell = {
  clauseId: "safety.weapons",
  clauseVersion: 1,
  tier: "t1",
  count: 0,
  fully: 0,
  partially: 0,
  not: 0,
  detected: 0,
  appealed: 0,
  overturned: 0,
};
const mk = (over: Partial<Cell>): Cell => ({ ...base, ...over });

describe("cell (k = 10)", () => {
  test("zero is shown, 1–9 suppressed, 10 and up shown", () => {
    expect(cell(0)).toEqual(v(0));
    expect(cell(1)).toEqual(S);
    expect(cell(9)).toEqual(S);
    expect(cell(10)).toEqual(v(10));
    expect(cell(12_345)).toEqual(v(12_345));
  });
});

describe("totalOver (complementary suppression of a total)", () => {
  test("exactly one suppressed part suppresses the total", () => {
    expect(totalOver(105, [100, 5])).toEqual(S);
    expect(totalOver(109, [100, 9, 0])).toEqual(S);
  });
  test("no suppressed part, or two or more: the total shows", () => {
    expect(totalOver(110, [100, 10])).toEqual(v(110));
    expect(totalOver(108, [100, 4, 4])).toEqual(v(108));
    expect(totalOver(100, [100, 0])).toEqual(v(100));
  });
  test("a total under k is suppressed on its own; an empty total is zero", () => {
    expect(totalOver(9, [4, 5])).toEqual(S);
    expect(totalOver(0, [])).toEqual(v(0));
  });
});

describe("partsOf (complementary suppression of parts)", () => {
  test("one small part: the smallest non-zero visible sibling goes too", () => {
    expect(partsOf([100, 3, 0])).toEqual([S, S, v(0)]);
    expect(partsOf([100, 50, 3])).toEqual([v(100), S, S]);
    expect(partsOf([10, 9])).toEqual([S, S]);
  });
  test("two small parts hide each other; none small changes nothing", () => {
    expect(partsOf([100, 3, 4])).toEqual([v(100), S, S]);
    expect(partsOf([100, 10, 0])).toEqual([v(100), v(10), v(0)]);
  });
});

describe("publishCell", () => {
  test("count at k − 1: every figure suppressed, the overturn rate too even at zero", () => {
    const r = publishCell(mk({ count: 9, fully: 9, detected: 9, appealed: 0, overturned: 0 }));
    expect(r.count).toEqual(S);
    expect(r.automatedDecision).toEqual({ fully: S, partially: v(0), not: v(0) });
    expect(r.automatedDetection).toEqual(S);
    expect(r.appealed).toEqual(S);
    expect(r.overturned).toEqual(S);
  });

  test("count at k: shown, with its split, detection and appeal figures", () => {
    const r = publishCell(mk({ count: 10, fully: 10, detected: 10, appealed: 0, overturned: 0 }));
    expect(r.count).toEqual(v(10));
    expect(r.automatedDecision).toEqual({ fully: v(10), partially: v(0), not: v(0) });
    expect(r.automatedDetection).toEqual(v(10));
    expect(r.appealed).toEqual(v(0));
    expect(r.overturned).toEqual(v(0));
    expect(r.ruleRef).toBe("safety.weapons@1");
    expect(r.group).toBe("safety");
  });

  test("a small split part hides a sibling, so the count does not give it away", () => {
    const r = publishCell(mk({ count: 50, fully: 48, not: 2, detected: 48 }));
    expect(r.count).toEqual(v(50));
    expect(r.automatedDecision).toEqual({ fully: S, partially: v(0), not: S });
  });

  test("detection is suppressed when the human-detected rest is under k", () => {
    expect(publishCell(mk({ count: 20, fully: 20, detected: 15 })).automatedDetection).toEqual(S);
    expect(publishCell(mk({ count: 30, fully: 30, detected: 15 })).automatedDetection).toEqual(v(15));
    expect(publishCell(mk({ count: 30, not: 30, detected: 0 })).automatedDetection).toEqual(v(0));
  });

  test("overturned and appealed below k are suppressed; at k they show", () => {
    const r = publishCell(mk({ count: 40, fully: 40, detected: 40, appealed: 12, overturned: 3 }));
    expect(r.appealed).toEqual(v(12));
    expect(r.overturned).toEqual(S);
    const r2 = publishCell(mk({ count: 40, fully: 40, detected: 40, appealed: 12, overturned: 10 }));
    expect(r2.overturned).toEqual(v(10));
  });

  test("guidelines.* is the general area; an unknown prefix falls back to it", () => {
    expect(publishCell(mk({ clauseId: "guidelines.general", count: 10, not: 10 })).group).toBe("general");
    expect(publishCell(mk({ clauseId: "zzz.new", count: 10, not: 10 })).group).toBe("general");
  });
});

describe("publishNcii", () => {
  test("on time and late at k: everything shows", () => {
    expect(publishNcii({ due: 30, onTime: 15, late: 15 })).toEqual({ due: v(30), onTime: v(15), late: v(15) });
  });
  test("one small part (late) suppresses the due total", () => {
    expect(publishNcii({ due: 20, onTime: 15, late: 5 })).toEqual({ due: S, onTime: v(15), late: S });
  });
  test("a small pending rest (due − on time − late) suppresses the due total", () => {
    expect(publishNcii({ due: 33, onTime: 15, late: 15 })).toEqual({ due: S, onTime: v(15), late: v(15) });
  });
  test("nothing due is all zeros", () => {
    expect(publishNcii({ due: 0, onTime: 0, late: 0 })).toEqual({ due: v(0), onTime: v(0), late: v(0) });
  });
});

describe("assemble", () => {
  const w = windowBounds("30d", new Date("2026-11-01T12:00:00Z"));

  test("an empty window: no rows, zero total, a valid contract shape", () => {
    const a = assemble("30d", w, [], { due: 0, onTime: 0, late: 0 });
    expect(a.rows).toEqual([]);
    expect(a.total).toEqual(v(0));
    const dto = {
      window: a.window,
      from: a.bounds.from.toISOString(),
      to: a.bounds.to.toISOString(),
      rows: [],
      total: a.total,
      ncii: a.ncii,
      generatedAt: a.bounds.to.toISOString(),
    };
    expect(EnforcementReport.parse(dto)).toEqual(dto);
  });

  test("cells of one rule and tier merge; rows sort by area, clause and tier", () => {
    const a = assemble(
      "30d",
      w,
      [
        mk({ clauseId: "mature.unlabelled", tier: "t2", count: 6, fully: 6, detected: 6 }),
        mk({ clauseId: "mature.unlabelled", tier: "t2", count: 6, fully: 6, detected: 6 }),
        mk({ clauseId: "safety.weapons", tier: null, count: 20, not: 20 }),
        mk({ clauseId: "safety.weapons", tier: "t1", count: 15, fully: 15, detected: 15 }),
        mk({ clauseId: "decency.hate", tier: null, count: 0 }),
      ],
      { due: 0, onTime: 0, late: 0 },
    );
    expect(a.rows.map((r) => `${r.ruleRef}/${r.tier}`)).toEqual([
      "safety.weapons@1/t1",
      "safety.weapons@1/null",
      "mature.unlabelled@1/t2",
    ]);
    expect(a.rows[2]?.count).toEqual(v(12));
    expect(a.total).toEqual(v(47));
  });

  test("one suppressed row suppresses the total; two leave it", () => {
    const one = assemble("30d", w, [mk({ count: 100, fully: 100 }), mk({ clauseId: "honesty.spam", count: 3 })], {
      due: 0,
      onTime: 0,
      late: 0,
    });
    expect(one.total).toEqual(S);
    const two = assemble(
      "30d",
      w,
      [mk({ count: 100 }), mk({ clauseId: "honesty.spam", count: 3 }), mk({ clauseId: "decency.hate", count: 4 })],
      { due: 0, onTime: 0, late: 0 },
    );
    expect(two.total).toEqual(v(107));
  });

  test("mergeCells adds every figure", () => {
    const [m] = mergeCells([mk({ count: 1, fully: 1, appealed: 1 }), mk({ count: 2, not: 2, overturned: 1 })]);
    expect(m).toMatchObject({ count: 3, fully: 1, not: 2, appealed: 1, overturned: 1 });
  });
});

describe("windowBounds", () => {
  const now = new Date("2026-11-15T08:30:00Z");

  test("30d ends at the start of today (UTC): [today − 30 d, today)", () => {
    const b = windowBounds("30d", now);
    expect(b).toEqual({
      from: new Date("2026-10-16T00:00:00Z"),
      to: new Date("2026-11-15T00:00:00Z"),
      empty: false,
      open: false,
    });
    // Two reads the same day cover the same window: no minute-by-minute differencing.
    expect(windowBounds("30d", new Date("2026-11-15T23:59:59.999Z"))).toEqual(b);
  });

  test("with the test hooks (live) 30d is the open-ended [now − 30 d, now)", () => {
    const b = windowBounds("30d", now, { live: true });
    expect(b.to).toEqual(now);
    expect(b.from).toEqual(new Date("2026-10-16T08:30:00Z"));
    expect(b.open).toBe(true);
  });

  test("a month runs from its first day 00:00 UTC to the next month's", () => {
    expect(windowBounds("2026-10", now)).toEqual({
      from: new Date("2026-10-01T00:00:00.000Z"),
      to: new Date("2026-11-01T00:00:00.000Z"),
      empty: false,
      open: false,
    });
    expect(windowBounds("2026-02", now).to).toEqual(new Date("2026-03-01T00:00:00.000Z"));
  });

  test("December runs into January of the next year", () => {
    const b = windowBounds("2025-12", now);
    expect(b.from).toEqual(new Date("2025-12-01T00:00:00.000Z"));
    expect(b.to).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });

  test("the current month runs to the start of today (to its end when live); next month is empty", () => {
    expect(windowBounds("2026-11", now)).toMatchObject({ to: new Date("2026-11-15T00:00:00Z"), empty: false });
    expect(windowBounds("2026-11", now, { live: true }).to).toEqual(new Date("2026-12-01T00:00:00Z"));
    expect(windowBounds("2026-12", now).empty).toBe(true);
    expect(windowBounds("2026-12", now, { live: true }).empty).toBe(true);
    // On the first, the month has no whole day yet.
    expect(windowBounds("2026-12", new Date("2026-12-01T09:00:00Z")).empty).toBe(true);
    expect(windowBounds("2026-12", new Date("2026-12-01T09:00:00Z"), { live: true }).empty).toBe(false);
  });

  test("months older than the 12 the report offers are empty (nothing is queried)", () => {
    expect(windowBounds("2025-12", now).empty).toBe(false);
    expect(windowBounds("2025-11", now).empty).toBe(true);
    expect(windowBounds("2020-02", now).empty).toBe(true);
    // Across a year boundary: in January the oldest offered month is February of last year.
    const jan = new Date("2027-01-10T00:00:00Z");
    expect(windowBounds("2026-02", jan).empty).toBe(false);
    expect(windowBounds("2026-01", jan).empty).toBe(true);
  });

  test("anything else is refused (the contract validates first)", () => {
    expect(() => windowBounds("2026-13", now)).toThrow("not a report window");
    expect(() => windowBounds("7d", now)).toThrow("not a report window");
  });
});

describe("overlapping windows (30d against the calendar months)", () => {
  const w = windowBounds("30d", new Date("2026-11-15T08:30:00Z"));
  const nil = { due: 0, onTime: 0, late: 0 };
  const piece = (cells: Cell[], ncii = nil) => ({ cells, ncii });

  test("a small slice of the previous month hides the 30d row (30d − Nov = Oct part; Oct − that = the rest)", () => {
    // Oct 1–15: 4 (outside 30d), Oct 16–31: 12, Nov 1–14: 12. Published: Oct 16, Nov 12, 30d 24.
    const outOct = mk({ count: 4, fully: 4, detected: 4 });
    const inOct = mk({ count: 12, fully: 12, detected: 12 });
    const inNov = mk({ count: 12, fully: 12, detected: 12 });
    const a = assemble("30d", w, [inOct, inNov], nil, [piece([outOct]), piece([inOct]), piece([inNov])]);
    expect(a.rows[0]?.count).toEqual(S);
    expect(a.rows[0]?.automatedDecision).toEqual({ fully: S, partially: v(0), not: v(0) });
    // The only row hidden: the total would give it away.
    expect(a.total).toEqual(S);
    // Without the pieces it would have been shown.
    expect(assemble("30d", w, [inOct, inNov], nil).rows[0]?.count).toEqual(v(24));
  });

  test("a small slice inside 30d hides it too, and a sibling row keeps the total visible", () => {
    const small = mk({ clauseId: "honesty.spam", tier: null, count: 3, not: 3 });
    const big = mk({ clauseId: "honesty.spam", tier: null, count: 20, not: 20 });
    const other = mk({ clauseId: "decency.hate", tier: null, count: 30, not: 30 });
    const otherSmall = mk({ clauseId: "decency.hate", tier: null, count: 5, not: 5 });
    const a = assemble("30d", w, [small, big, other, otherSmall], nil, [
      piece([small, other]),
      piece([big, otherSmall]),
    ]);
    expect(a.rows.map((r) => r.count)).toEqual([S, S]);
    expect(a.total).toEqual(v(58));
  });

  test("a figure small in one slice is hidden in 30d; the split hides a sibling with it", () => {
    const p1 = mk({ count: 20, fully: 15, not: 5, detected: 15, appealed: 3, overturned: 0 });
    const p2 = mk({ count: 20, fully: 20, detected: 20, appealed: 10, overturned: 10 });
    const a = assemble("30d", w, [p1, p2], nil, [piece([p1]), piece([p2])]);
    const row = a.rows[0];
    expect(row?.count).toEqual(v(40));
    // `not` is 5 in one slice: hidden, and `fully` with it so count − fully does not show it.
    expect(row?.automatedDecision).toEqual({ fully: S, partially: v(0), not: S });
    // The human-detected rest is 5 in one slice.
    expect(row?.automatedDetection).toEqual(S);
    expect(row?.appealed).toEqual(S);
    expect(row?.overturned).toEqual(v(10));
  });

  test("a small slice of the total hides the total, even with two rows hidden", () => {
    // Slice 1 holds a: 4 and b: 3 (a total of 7); slice 2 holds a: 20, b: 20, c: 30.
    const a1 = mk({ count: 4, fully: 4, detected: 4 });
    const b1 = mk({ clauseId: "honesty.spam", count: 3, fully: 3, detected: 3 });
    const a2 = mk({ count: 20, fully: 20, detected: 20 });
    const b2 = mk({ clauseId: "honesty.spam", count: 20, fully: 20, detected: 20 });
    const c2 = mk({ clauseId: "decency.hate", count: 30, fully: 30, detected: 30 });
    const r = assemble("30d", w, [a1, b1, a2, b2, c2], nil, [piece([a1, b1]), piece([a2, b2, c2])]);
    expect(r.rows.map((x) => [x.clauseId, x.count])).toEqual([
      ["safety.weapons", S],
      ["decency.hate", v(30)],
      ["honesty.spam", S],
    ]);
    // Two hidden rows would leave the total, but 30d − slice 2's month gives slice 1's 7.
    expect(r.total).toEqual(S);
    expect(assemble("30d", w, [a1, b1, a2, b2, c2], nil, [piece([a1, b1, a2, b2, c2])]).total).toEqual(v(77));
  });

  test("NCII: a small slice hides that figure, and the due total when it is the only one", () => {
    const n = { due: 30, onTime: 20, late: 10 };
    const r = assemble("30d", w, [], n, [
      piece([], { due: 15, onTime: 15, late: 0 }),
      piece([], { due: 15, onTime: 5, late: 10 }),
    ]);
    expect(r.ncii).toEqual({ due: S, onTime: S, late: v(10) });
    expect(forcedBy([piece([], { due: 12, onTime: 10, late: 0 })]).ncii).toEqual({ pending: true });
  });

  test("zero is never forced hidden", () => {
    const p = mk({ count: 3, fully: 3, detected: 3 });
    const f = forcedBy([piece([p])]).cells.get("safety.weapons@1|t1");
    expect(f).toEqual({ count: true, fully: true, detected: true });
    expect(publishCell(mk({ count: 40, fully: 40, detected: 40 }), f).automatedDecision.partially).toEqual(v(0));
  });
});

describe("tiers", () => {
  test("source actions map to tiers; NCII requests and unknown actions have none", () => {
    expect(tierOfSource("moderation.t1.restrict")).toBe("t1");
    expect(tierOfSource("moderation.t1.upload_reject")).toBe("t1");
    expect(tierOfSource("moderation.t2.label")).toBe("t2");
    expect(tierOfSource("moderation.t0.match")).toBe("t0");
    expect(tierOfSource("moderation.case.suspend")).toBe("t1");
    expect(tierOfSource("ncii.decide")).toBeNull();
    expect(tierOfSource("toString")).toBeNull();
  });
});

describe("rule-ref helpers", () => {
  test("report reasons cite their clause", () => {
    expect(reportReasonRuleRef("minor_safety")).toBe("safety.minors@1");
    expect(reportReasonRuleRef("ncii")).toBe("decency.intimate-images@1");
    expect(reportReasonRuleRef("other")).toBe("guidelines.general@1");
  });

  test("a staff clause id resolves to its current version; none is null; unknown is refused", () => {
    expect(staffRuleRef("honesty.spam")).toBe("honesty.spam@1");
    expect(staffRuleRef("decency.intimate-images")).toBe("decency.intimate-images@1");
    expect(staffRuleRef(undefined)).toBeNull();
    expect(() => staffRuleRef("no.such-clause")).toThrow("Unknown clause");
  });

  test("staff cannot cite the illegal ground the NCII process reserves", () => {
    expect(() => staffRuleRef("illegal.ncii")).toThrow("not available to staff actions");
  });

  test("case decisions: category first, else a human case's report reason, else general", () => {
    const human = { origin: "human" } as const;
    const classifier = { origin: "classifier" } as const;
    expect(caseDecisionRuleRef({ ...classifier, category: "weapons", ruleRef: "safety.weapons@1" }, "warn")).toBe(
      "safety.weapons@1",
    );
    expect(caseDecisionRuleRef({ ...human, category: null, ruleRef: "safety.minors@1" }, "suspend")).toBe(
      "safety.minors@1",
    );
    expect(caseDecisionRuleRef({ ...human, category: null, ruleRef: null }, "end_stream")).toBe("guidelines.general@1");
  });

  test("a T0 NCII-list case's clause is not what a decision on it cites (the statement cites general)", () => {
    expect(caseDecisionRuleRef({ origin: "hash_list", category: null, ruleRef: "illegal.ncii@1" }, "suspend")).toBe(
      "guidelines.general@1",
    );
    // Escalated to T0 by a moderator (origin human), still not a report reason.
    expect(caseDecisionRuleRef({ origin: "human", category: null, ruleRef: "illegal.ncii@1" }, "warn")).toBe(
      "guidelines.general@1",
    );
    // A classifier case without a category does not borrow a report reason either.
    expect(caseDecisionRuleRef({ origin: "classifier", category: null, ruleRef: "safety.minors@1" }, "warn")).toBe(
      "guidelines.general@1",
    );
  });

  test("a decided case keeps its clause; one without takes the decision's (none for clear)", () => {
    const o = { origin: "classifier" } as const;
    expect(caseRuleRefAfter({ ...o, category: "weapons", ruleRef: "safety.weapons@1" }, "clear")).toBe(
      "safety.weapons@1",
    );
    expect(caseRuleRefAfter({ ...o, category: "self_harm", ruleRef: null }, "warn")).toBe("safety.self-harm@1");
    expect(caseRuleRefAfter({ ...o, category: null, ruleRef: null }, "clear")).toBeNull();
  });
});

describe("locale and titles", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  test("user choice, then the web cookie, then Accept-Language, then English", () => {
    expect(requestLocale({ userLocale: "es", headers: h({ "accept-language": "en" }) })).toBe("es");
    expect(requestLocale({ userLocale: null, headers: h({ cookie: "a=1; commonair-locale=es-MX" }) })).toBe("es");
    expect(requestLocale({ userLocale: null, headers: h({ "accept-language": "fr;q=0.9, es;q=0.8" }) })).toBe("es");
    expect(requestLocale({ userLocale: null, headers: h({}) })).toBe("en");
    expect(requestLocale({ userLocale: "en-XA", headers: h({ "accept-language": "es" }) })).toBe("en");
  });

  test("Accept-Language parsing drops q=0, * and junk", () => {
    expect(acceptLanguageTags("es;q=0.5, de, *;q=0.1, fr;q=0, ;;, x y")).toEqual(["de", "es"]);
    expect(acceptLanguageTags(null)).toEqual([]);
  });

  test("clause titles come from the email catalog in the locale, English as fallback", () => {
    expect(clauseTitleIn("en", "safety.weapons", 1)).toBe("Dangerous weapons");
    expect(clauseTitleIn("es", "safety.weapons", 1)).not.toBe("Dangerous weapons");
    expect(clauseTitleIn("xx", "safety.weapons", 1)).toBe("Dangerous weapons");
    expect(clauseTitleIn("en", "nope.gone", 3)).toBe("nope.gone");
  });
});
