// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d2-pages pure logic: the co-op facts the acquisition pages quote, the fee calculator's sums,
 * the legal documents' Markdown subset, the claim field's name rules and links, and the co-op
 * explainers' numbers.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { claimHref, normalizeClaim, statusOf } from "../src/components/creators/claim-field.tsx";
import { explainerLinks } from "../src/components/coop/explainer-join.tsx";
import { showJoinBand } from "../src/components/coop/join-band.tsx";
import { patronageStanding, patronageWeights } from "../src/components/coop/patronage-explainer.tsx";
import { NO_FACTS, coopFacts } from "../src/components/creators/facts.ts";
import { conditionText } from "../src/components/creators/fee-calculator.tsx";
import { instanceHost } from "../src/components/creators/host.ts";
import {
  AVERAGE_TIP_CENTS,
  CALC_LIMITS,
  COMPETITOR_RATES,
  RATES_CHECKED,
  SUBSCRIBER_PRESETS,
  barShare,
  calculate,
  calculateRow,
  commonAirRate,
  tipPayments,
  type CompetitorId,
} from "../src/components/creators/rates.ts";
import { PUBLIC_LEGAL_KINDS } from "../src/components/legal-pages/kinds.ts";
import { legalDocOf } from "../src/components/legal-pages/legal-page.tsx";
import { parseInline, parseMarkdown, slugify, tableOfContents } from "../src/components/legal-pages/markdown.ts";

/** The founding seed (`packages/db/src/seed.ts`). */
const SEED = [
  { key: "platform.cut", value: { streamerShare: 0.9, coopShare: 0.1 } },
  {
    key: "payout.rules",
    value: { minimumCents: 2500, schedule: "monthly", holdDays: 7, currency: "usd" },
  },
  {
    key: "membership.classes",
    value: {
      streamer: { minStreamingHours: 10, windowDays: 90, minVerifiedViewers: 2, lapseGraceDays: 14 },
      viewer: {
        shareCents: 500,
        shareRefundableOnExit: true,
        activeSubscriptionQualifies: true,
        minSubscriptionCents: 300,
      },
      worker: { appointedBy: "board" },
    },
  },
  { key: "governance.protections", value: { memberWideThreshold: 2 / 3, streamerClassThreshold: 0.5 } },
  {
    key: "patronage.formula",
    value: { weights: { revenue: 0.5, streamingHours: 0.2, relayBandwidth: 0.2, viewerHours: 0.1 } },
  },
];

describe("coopFacts", () => {
  it("reads the founding seed", () => {
    expect(coopFacts(SEED, [])).toEqual({
      creatorShare: 0.9,
      payout: { minimumCents: 2500, holdDays: 7, currency: "usd" },
      membership: {
        shareCents: 500,
        refundableOnExit: true,
        minSubCents: 300,
        streamerHours: 10,
        streamerViewers: 2,
        windowDays: 90,
      },
      protections: { memberWide: 2 / 3, streamerClass: 0.5 },
      cutChanges: 0,
    });
  });

  it("is all null without settings, and counts only decided cut changes", () => {
    expect(coopFacts(null)).toEqual(NO_FACTS);
    expect(coopFacts([], null).cutChanges).toBeNull();
    const schedule = [
      { key: "platform.cut", changedAt: null },
      { key: "platform.cut", changedAt: "2026-10-01T00:00:00Z" },
      { key: "payout.rules", changedAt: "2026-10-02T00:00:00Z" },
      { key: "platform.cut", changedAt: "2026-10-03T00:00:00Z" },
    ];
    expect(coopFacts([], schedule).cutChanges).toBe(2);
  });

  it("drops a part whose setting has another shape, keeping the rest", () => {
    const facts = coopFacts([
      { key: "platform.cut", value: { streamerShare: 1.2 } },
      { key: "payout.rules", value: { minimumCents: 25.5, holdDays: 7, currency: "usd" } },
      { key: "membership.classes", value: { viewer: { shareCents: 500 } } },
      { key: "governance.protections", value: "two thirds" },
    ]);
    expect(facts).toEqual({ ...NO_FACTS, cutChanges: null });
  });

  it("has no qualifying sub when subscriptions don't qualify, or no minimum is set", () => {
    const classes = (viewer: Record<string, unknown>) => [
      {
        key: "membership.classes",
        value: { streamer: { minStreamingHours: 10, windowDays: 90, minVerifiedViewers: 2 }, viewer },
      },
    ];
    const base = { shareCents: 500, shareRefundableOnExit: false };
    expect(
      coopFacts(classes({ ...base, activeSubscriptionQualifies: false, minSubscriptionCents: 300 })).membership
        ?.minSubCents,
    ).toBeNull();
    expect(coopFacts(classes(base)).membership?.minSubCents).toBeNull();
    expect(coopFacts(classes(base)).membership?.refundableOnExit).toBe(false);
  });
});

describe("the fee calculator", () => {
  const input = { subscribers: 100, subPriceCents: 500, tipsCents: 20_000 };

  it("dates every competitor figure and links a source for each", () => {
    expect(RATES_CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(COMPETITOR_RATES.map((r) => r.id)).toEqual(["kick", "youtube", "twitch", "patreon", "kofi"]);
    for (const rate of COMPETITOR_RATES) expect(rate.source?.url).toMatch(/^https:\/\//);
    // Ko-fi's figures came from a secondary source (its help pages blocked automated reads).
    expect(COMPETITOR_RATES.filter((r) => r.source?.secondary).map((r) => r.id)).toEqual(["kofi"]);
  });

  it("matches the mockup's worked example at 100 subs of $5 and $200 of tips", () => {
    const rows = Object.fromEntries(calculate(0.9, input).map((r) => [r.id, r]));
    expect(rows.commonair).toEqual({ id: "commonair", netCents: 63_000, altNetCents: null, grossCents: 70_000 });
    // Kick: a fixed $5 sub at 95%, tips at 100%.
    expect(rows.kick?.netCents).toBe(47_500 + 20_000);
    expect(rows.youtube?.netCents).toBe(35_000 + 14_000);
    // Twitch: Bits left out; 70% is shown beside the default.
    expect(rows.twitch).toEqual({ id: "twitch", netCents: 25_000, altNetCents: 35_000, grossCents: 50_000 });
    // Patreon: 90%, then 2.9% of gross and 30¢ on each of 100 subs and 20 tips ($10 average).
    expect(rows.patreon?.netCents).toBe(63_000 - 2030 - 120 * 30);
    expect(rows.kofi?.netCents).toBe(47_500 + 20_000 - 2030 - 120 * 30);
  });

  it("follows the creator share from platform.cut", () => {
    expect(calculateRow(commonAirRate(0.85), input).netCents).toBe(59_500);
    expect(calculateRow(commonAirRate(1), input).netCents).toBe(70_000);
  });

  it("uses Kick's fixed price whatever the creator charges", () => {
    const kick = COMPETITOR_RATES.find((r) => r.id === "kick");
    if (!kick) throw new Error("no kick row");
    expect(calculateRow(kick, { ...input, subPriceCents: 2500, tipsCents: 0 }).netCents).toBe(47_500);
  });

  it("is zero on an empty month and never negative", () => {
    for (const row of calculate(0.9, { subscribers: 0, subPriceCents: 500, tipsCents: 0 })) {
      expect(row.netCents).toBe(0);
      expect(row.grossCents).toBe(0);
    }
    // One 1¢ tip on Patreon: the 30¢ fee is larger than the tip.
    const patreon = COMPETITOR_RATES.find((r) => r.id === "patreon");
    if (!patreon) throw new Error("no patreon row");
    expect(calculateRow(patreon, { subscribers: 0, subPriceCents: 500, tipsCents: 1 }).netCents).toBe(0);
  });

  it("rounds to whole cents and floors fractional or negative inputs", () => {
    const row = calculateRow(commonAirRate(0.9), { subscribers: 3.7, subPriceCents: 333, tipsCents: -50 });
    expect(Number.isInteger(row.netCents)).toBe(true);
    expect(row.grossCents).toBe(999);
    expect(row.netCents).toBe(899);
  });

  it("counts tip payments at the $10 average, at least one when there are tips", () => {
    expect(AVERAGE_TIP_CENTS).toBe(1000);
    expect(tipPayments(0)).toBe(0);
    expect(tipPayments(-1)).toBe(0);
    expect(tipPayments(1)).toBe(1);
    expect(tipPayments(1499)).toBe(1);
    expect(tipPayments(1500)).toBe(2);
    expect(tipPayments(20_000)).toBe(20);
  });

  it("sizes bars against the largest figure, alt figures included", () => {
    const rows = calculate(0.9, input);
    // Kick is the largest row here ($675); a figure above it is capped at a full bar.
    expect(barShare(67_500, rows)).toBe(1);
    expect(barShare(70_000, rows)).toBe(1);
    expect(barShare(0, rows)).toBe(0);
    expect(barShare(63_000, rows)).toBeCloseTo(63_000 / 67_500);
    expect(barShare(5, calculate(0.9, { subscribers: 0, subPriceCents: 500, tipsCents: 0 }))).toBe(0);
  });

  it("starts the sliders inside their ranges, on a step", () => {
    for (const limits of Object.values(CALC_LIMITS)) {
      expect(limits.initial).toBeGreaterThanOrEqual(limits.min);
      expect(limits.initial).toBeLessThanOrEqual(limits.max);
      expect((limits.initial - limits.min) % limits.step).toBe(0);
    }
    for (const n of SUBSCRIBER_PRESETS) expect(n % CALC_LIMITS.subscribers.step).toBe(0);
  });

  it("states each competitor's condition with figures from the table", () => {
    const text = (id: CompetitorId) => conditionText(id, "en");
    expect(text("kick")).toBe("95% of subs with KICK Streamer status. Subs are a flat $5.00. Tips: 100%.");
    expect(text("youtube")).toContain("70% of net");
    expect(text("twitch")).toContain("50% of net by default, 70% after 3 months");
    expect(text("patreon")).toContain("A 10% platform fee plus card processing, here 2.9% + $0.30 a payment.");
    expect(text("kofi")).toContain("5% on memberships");
  });
});

describe("legal Markdown", () => {
  it("parses headings, paragraphs, lists with continuation lines and quotes", () => {
    const blocks = parseMarkdown(
      [
        "<!-- SPDX -->",
        "> **Draft pending review.** Questions: help@air.example.",
        "",
        "Intro line one",
        "continues here.",
        "",
        "## 1. Who can use it",
        "",
        "- You must be at least **16 years old**.",
        "  The birth date can't change.",
        "- Second item",
        "",
        "1. **No purchase necessary.** Free.",
        "2. Sponsor.",
        "",
        "### Details",
        "See https://air.example/terms, then *carefully* read `code`.",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      "quote",
      "paragraph",
      "heading",
      "list",
      "list",
      "heading",
      "paragraph",
    ]);
    expect(blocks[1]).toEqual({
      kind: "paragraph",
      inline: [{ kind: "text", text: "Intro line one continues here." }],
    });
    expect(blocks[2]).toEqual({ kind: "heading", level: 2, id: "1-who-can-use-it", text: "1. Who can use it" });
    const list = blocks[3];
    expect(list?.kind === "list" && list.ordered).toBe(false);
    if (list?.kind !== "list") throw new Error("not a list");
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toEqual([
      { kind: "text", text: "You must be at least " },
      { kind: "strong", children: [{ kind: "text", text: "16 years old" }] },
      { kind: "text", text: ". The birth date can't change." },
    ]);
    const ordered = blocks[4];
    expect(ordered?.kind === "list" && ordered.ordered && ordered.items.length).toBe(2);
    expect(blocks[5]).toMatchObject({ kind: "heading", level: 3, id: "details" });
    const quote = blocks[0];
    if (quote?.kind !== "quote") throw new Error("not a quote");
    expect(quote.blocks[0]).toEqual({
      kind: "paragraph",
      inline: [
        { kind: "strong", children: [{ kind: "text", text: "Draft pending review." }] },
        { kind: "text", text: " Questions: " },
        { kind: "link", href: "mailto:help@air.example", text: "help@air.example" },
        { kind: "text", text: "." },
      ],
    });
  });

  it("links bare URLs without their trailing punctuation, and keeps emphasis and code", () => {
    expect(parseInline("See https://air.example/terms, then *carefully* read `a*b`.")).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", href: "https://air.example/terms", text: "https://air.example/terms" },
      { kind: "text", text: ", then " },
      { kind: "em", children: [{ kind: "text", text: "carefully" }] },
      { kind: "text", text: " read " },
      { kind: "code", text: "a*b" },
      { kind: "text", text: "." },
    ]);
  });

  it("keeps unmatched markers and markup as text (nothing becomes HTML)", () => {
    expect(parseInline("2 * 3 and **open <script>")).toEqual([{ kind: "text", text: "2 * 3 and **open <script>" }]);
    expect(parseInline("javascript:alert(1)")).toEqual([{ kind: "text", text: "javascript:alert(1)" }]);
  });

  it("gives every heading a unique anchor and lists them in the table of contents", () => {
    const blocks = parseMarkdown("## Changes\n\ntext\n\n## Changes\n\n> ## Quoted\n\n## ¿Qué?\n\n## !!!");
    expect(tableOfContents(blocks)).toEqual([
      { id: "changes", text: "Changes", level: 2 },
      { id: "changes-2", text: "Changes", level: 2 },
      { id: "quoted", text: "Quoted", level: 2 },
      { id: "que", text: "¿Qué?", level: 2 },
      { id: "section", text: "!!!", level: 2 },
    ]);
    const taken = new Set(["a"]);
    expect(slugify("A", taken)).toBe("a-2");
    expect(slugify("A", taken)).toBe("a-3");
  });

  it("is empty for an empty body and survives CRLF line ends", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("## One\r\n\r\n- a\r\n- b\r\n").map((b) => b.kind)).toEqual(["heading", "list"]);
  });

  it.each(PUBLIC_LEGAL_KINDS)("parses the shipped %s document into sections", (kind) => {
    const body = readFileSync(new URL(`../../../packages/db/src/legal/${kind}.md`, import.meta.url), "utf8");
    const blocks = parseMarkdown(body);
    const toc = tableOfContents(blocks);
    expect(toc.length).toBeGreaterThan(4);
    expect(new Set(toc.map((e) => e.id)).size).toBe(toc.length);
    // Placeholders are filled by the API; the parser leaves them as text.
    expect(JSON.stringify(blocks)).not.toContain("<!--");
  });

  it("maps a loader answer to the page's doc", () => {
    const doc = {
      id: "d",
      kind: "terms" as const,
      title: "Terms",
      version: "v1",
      body: "",
      isDraft: false,
      requiresAcceptance: true,
    };
    expect(legalDocOf({ status: "ok", data: doc })).toBe(doc);
    expect(legalDocOf({ status: "ok", data: null })).toBeNull();
    expect(legalDocOf({ status: "failed", retryAfterSeconds: 5 })).toBeUndefined();
    expect(legalDocOf(undefined)).toBeUndefined();
  });
});

describe("the claim field's rules", () => {
  it("normalizes to a username sign-up would accept", () => {
    expect(normalizeClaim("  River_Tide ")).toBe("river_tide");
    expect(normalizeClaim("ab")).toBeNull();
    expect(normalizeClaim("a".repeat(26))).toBeNull();
    expect(normalizeClaim("aurora-pixel")).toBeNull();
    expect(normalizeClaim("")).toBeNull();
  });

  it("links sign-up with the stream intent and the name", () => {
    expect(claimHref("river_tide")).toBe("/signup?intent=stream&username=river_tide");
  });

  it("maps the availability answer", () => {
    expect(statusOf({ username: "a", available: true, reason: null }, "abc")).toEqual({ kind: "free", name: "abc" });
    expect(statusOf({ username: "a", available: false, reason: "taken" }, "abc")).toEqual({
      kind: "taken",
      name: "abc",
    });
    expect(statusOf({ username: "a", available: false, reason: "reserved" }, "fees")).toEqual({
      kind: "reserved",
      name: "fees",
    });
    expect(statusOf({ username: "a", available: false, reason: "invalid" }, "abc")).toEqual({ kind: "invalid" });
    // Unavailable with no reason is treated as taken, never as free.
    expect(statusOf({ username: "a", available: false, reason: null }, "abc")).toEqual({ kind: "taken", name: "abc" });
  });

  it("shows the instance host before the name", () => {
    expect(instanceHost("https://air.example")).toBe("air.example/");
    expect(instanceHost("http://localhost:3000/")).toBe("localhost:3000/");
    expect(instanceHost("not a url")).toBe("/");
  });
});

describe("the co-op explainers and the join band", () => {
  it("links sign-up and sign-in back to the explainer", () => {
    expect(explainerLinks("/coop/jury")).toEqual({
      signup: "/signup?intent=join&redirect=%2Fcoop%2Fjury",
      signin: "/signin?redirect=%2Fcoop%2Fjury",
    });
  });

  it("shows the join band to visitors and to accounts that aren't members, not while loading", () => {
    const active = { memberships: [{ class: "viewer" as const, status: "active" as const }] };
    const lapsed = { memberships: [{ class: "viewer" as const, status: "lapsed" as const }] };
    expect(showJoinBand(false, null)).toBe(true);
    expect(showJoinBand(true, null)).toBe(false);
    expect(showJoinBand(true, { memberships: [] })).toBe(true);
    expect(showJoinBand(true, lapsed as never)).toBe(true);
    expect(showJoinBand(true, active as never)).toBe(false);
  });

  it("reads the patronage weights", () => {
    expect(patronageWeights(SEED)).toEqual({
      revenue: 0.5,
      streamingHours: 0.2,
      relayBandwidth: 0.2,
      viewerHours: 0.1,
    });
    expect(patronageWeights(null)).toBeNull();
    expect(patronageWeights([{ key: "patronage.formula", value: { weights: { revenue: 2 } } }])).toBeNull();
  });

  it("sums the books it was given, never projecting", () => {
    const usd = (cents: number) => ({ cents, currency: "usd" });
    const month = (surplus: number, shared = 0) => ({ surplus: usd(surplus), patronageDistributed: usd(shared) });
    expect(patronageStanding(null)).toBeNull();
    expect(patronageStanding([])).toBeNull();
    expect(patronageStanding([month(-500), month(200, 50)])).toEqual({
      months: 2,
      surplusCents: -300,
      distributedCents: 50,
      currency: "usd",
    });
    expect(
      patronageStanding([month(1), { surplus: { cents: 1, currency: "eur" }, patronageDistributed: usd(0) }]),
    ).toBeNull();
  });
});
