// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d6-governance (overhaul D6.2): every governance setting in words. Each seeded key has a summary
 * and its fields; unknown keys, wrong types and malformed values fall back without throwing.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  KNOWN_SETTING_KEYS,
  SETTING_THEMES,
  applyField,
  complementShare,
  describeCron,
  durationText,
  durationUnit,
  fieldBoundText,
  fieldError,
  formatField,
  fractionFromPercent,
  genericValueText,
  isKnownSetting,
  leafPaths,
  percentFromFraction,
  readPath,
  sameValue,
  settingDiff,
  settingFieldSpecs,
  settingFields,
  settingSummary,
  settingTheme,
  settingTitle,
  themeHint,
  themeLabel,
  typedEditable,
  writePath,
} from "../src/lib/coop-settings-format.ts";

const L = "en";
const byText = (a: string | undefined, b: string | undefined) => (a ?? "").localeCompare(b ?? "");

/** The seeded values (packages/db/src/seed.ts), as members see them on a new instance. */
const SEED: Record<string, unknown> = {
  "governance.protections": {
    protectedKeys: [
      "platform.cut",
      "patronage.formula",
      "payout.rules",
      "membership.classes",
      "governance.protections",
    ],
    memberWideThreshold: 2 / 3,
    streamerClassThreshold: 0.5,
    quorum: 0.2,
    streamerClassQuorum: 0.2,
    councilReviewSeconds: 604_800,
    minVotingSeconds: 604_800,
  },
  "platform.cut": { streamerShare: 0.9, coopShare: 0.1 },
  "patronage.formula": {
    version: "2026.1",
    weights: {
      revenue: 0.5,
      streamingHours: 0.2,
      relayBandwidth: 0.2,
      viewerHours: 0.1,
      dailyStreamingHourCap: 8,
      viewerHoursChannelCap: 0.1,
    },
  },
  "payout.rules": {
    minimumCents: 2500,
    schedule: "monthly",
    holdDays: 7,
    currency: "usd",
    splitShortfallWriteOffDays: 365,
    splitNewRecipientHoldDays: 7,
    splitRecipientMinAccountAgeDays: 30,
  },
  "membership.classes": {
    streamer: { minStreamingHours: 10, windowDays: 90, minVerifiedViewers: 2, lapseGraceDays: 14 },
    viewer: {
      shareCents: 500,
      shareRefundableOnExit: true,
      activeSubscriptionQualifies: true,
      minSubscriptionCents: 300,
    },
    worker: { appointedBy: "board" },
  },
  "governance.ordinary": {
    threshold: 0.5,
    quorum: 0.1,
    discussionSeconds: 1_209_600,
    minVotingSeconds: 259_200,
    votingSeconds: 604_800,
  },
  "board.seats": { streamer: 3, viewer: 3, worker: 1, termMonths: 24 },
  "council.config": { size: 7, eligibilityWindowDays: 90, minStreamingHours: 10, recomputeCron: "0 3 1 * *" },
  "discovery.ranking": {
    spotlightSlots: 4,
    spotlightMaxViewers: 10,
    spotlightRotationMinutes: 10,
    newChannelMaxAgeDays: 30,
    weights: { viewers: 0.4, freshness: 0.2, followMomentum: 0.2, smallChannelBoost: 0.2 },
  },
  "integrity.thresholds": {
    sessionExcludeScore: 0.7,
    followBurstPerMinute: 30,
    relayOverReportTolerance: 0.1,
    maxSessionsPerDevice: 3,
    gateUnlocksPerAddress: 5,
    gateFallbackAccountAgeDays: 7,
  },
  "moderation.thresholds": {
    t1: { sexual: 0.97, graphic_violence: 0.9, weapons: 0.95, self_harm: 0.9 },
    t2: { sexual: 0.8 },
    sampleSeconds: 10,
  },
  "interact.points.accrual": { pointsPerBlock: 10, blockMinutes: 5, dailyCapPerChannel: 1000 },
  "notifications.goLive": { cooldownHours: 4, emailDigestMinutes: 5 },
  "captions.defaultEnabled": { enabled: false },
  "jury.enabled": { enabled: false },
  "jury.panelSize": { panelSize: 7 },
  "jury.casesPerPanel": { casesPerPanel: 20 },
  "shares.cardPayments": { enabled: false },
};

const EXPECTED: Record<string, string> = {
  "governance.protections": "two thirds of members and a streamer majority · 20% quorum · 7-day council review",
  "platform.cut": "Creators keep 90% · co-op 10%",
  "patronage.formula": "Revenue 50% · streaming hours 20% · relay bandwidth 20% · viewer hours 10%",
  "payout.rules": "$25.00 minimum · paid monthly · 7 days hold",
  "membership.classes": "Streamers: 10 hours streamed in 90 days · Viewers: a $5.00 share or a subscription",
  "governance.ordinary": "10% quorum · simple majority · 14-day discussion · 7-day vote",
  "board.seats": "3 streamer, 3 viewer and 1 worker seats · terms of 24 months",
  "council.config": "7 seats · 10 hours streamed in the last 90 days to be eligible",
  "discovery.ranking": "4 spotlight slots for channels under 10 viewers · rotates every 10 minutes",
  "integrity.thresholds": "Sessions scoring over 0.7 are left out of counts · up to 3 sessions per device",
  "moderation.thresholds": "A frame checked every 10 seconds · mature label above 0.8",
  "interact.points.accrual": "10 points every 5 minutes watched · up to 1,000 a day per channel",
  "notifications.goLive": "At most one alert per channel every 4 hours · emails wait 5 minutes",
  "captions.defaultEnabled": "Off unless a channel turns them on",
  "jury.enabled": "Off",
  "jury.panelSize": "7 jurors per panel",
  "jury.casesPerPanel": "20 cases per panel",
  "shares.cardPayments": "Shares by bank transfer only, confirmed by a treasurer",
};

describe("the seeded settings", () => {
  it("covers every key the database seeds", () => {
    const seed = readFileSync(new URL("../../../packages/db/src/seed.ts", import.meta.url), "utf8");
    const keys = [...seed.matchAll(/^\s+key: "([a-zA-Z.]+)",$/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.toSorted(byText)).toEqual([...KNOWN_SETTING_KEYS].toSorted(byText));
    expect(Object.keys(SEED).toSorted(byText)).toEqual(keys.toSorted(byText));
  });

  it.each(Object.keys(EXPECTED))("%s reads in words", (key) => {
    expect(settingSummary(key, SEED[key], L)).toBe(EXPECTED[key]);
  });

  it.each(KNOWN_SETTING_KEYS)("%s has a title, a theme and every seeded field formatted", (key) => {
    expect(settingTitle(key)).not.toBe(key);
    expect(settingTheme(key)).not.toBe("other");
    const fields = settingFields(key, SEED[key], L);
    expect(fields.length).toBe(settingFieldSpecs(key).length);
    for (const f of fields) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.text).not.toContain("{");
      expect(f.text).not.toMatch(/^\[object/);
    }
  });

  it("formats the fields members care about", () => {
    const text = (key: string, id: string) => settingFields(key, SEED[key], L).find((f) => f.id === id)?.text;
    expect(text("platform.cut", "streamerShare")).toBe("90%");
    expect(text("governance.protections", "memberWideThreshold")).toBe("66.7%");
    expect(text("governance.protections", "councilReviewSeconds")).toBe("7 days");
    expect(text("governance.protections", "protectedKeys")).toBe(
      "Creator share of revenue, Patronage formula, Payouts, Membership classes, Rules for protected decisions",
    );
    expect(text("governance.ordinary", "minVotingSeconds")).toBe("3 days");
    expect(text("payout.rules", "minimumCents")).toBe("$25.00");
    expect(text("payout.rules", "currency")).toBe("USD");
    expect(text("payout.rules", "schedule")).toBe("monthly");
    expect(text("membership.classes", "viewer.shareRefundableOnExit")).toBe("On");
    expect(text("membership.classes", "worker.appointedBy")).toBe("The board");
    expect(text("council.config", "recomputeCron")).toBe("Monthly, on day 1 at 03:00 UTC");
    expect(text("board.seats", "termMonths")).toBe("24 months");
    expect(text("moderation.thresholds", "t1.sexual")).toBe("0.97");
    expect(text("moderation.thresholds", "sampleSeconds")).toBe("10 seconds");
    expect(text("patronage.formula", "weights.dailyStreamingHourCap")).toBe("8 hours");
    expect(text("patronage.formula", "version")).toBe("2026.1");
  });

  it("puts every key in one of the six themes", () => {
    const themes = new Set(KNOWN_SETTING_KEYS.map(settingTheme));
    expect([...themes].toSorted()).toEqual(["discovery", "features", "governance", "membership", "money", "safety"]);
    for (const theme of SETTING_THEMES) {
      expect(themeLabel(theme).length).toBeGreaterThan(0);
      expect(themeHint(theme).length).toBeGreaterThan(0);
    }
  });
});

describe("rule wording", () => {
  it("names a threshold other than half or two thirds as a percent", () => {
    expect(
      settingSummary("governance.ordinary", { ...(SEED["governance.ordinary"] as object), threshold: 0.6 }, L),
    ).toBe("10% quorum · 60% yes · 14-day discussion · 7-day vote");
    expect(
      settingSummary(
        "governance.protections",
        { ...(SEED["governance.protections"] as object), memberWideThreshold: 0.75, streamerClassThreshold: 0.6 },
        L,
      ),
    ).toBe("75% yes of members and more than 60% of streamers · 20% quorum · 7-day council review");
  });

  it("reads periods in the largest whole unit", () => {
    expect(durationUnit(0)).toBe("days");
    expect(durationUnit(86_400 * 3)).toBe("days");
    expect(durationUnit(7_200)).toBe("hours");
    expect(durationUnit(90)).toBe("seconds");
    expect(durationUnit(5_400)).toBe("minutes");
    expect(durationText(1_209_600, L)).toBe("14 days");
    expect(durationText(1, L)).toBe("1 second");
    expect(durationText(0, L)).toBe("0 days");
    expect(
      settingSummary(
        "governance.ordinary",
        { ...(SEED["governance.ordinary"] as object), discussionSeconds: 3_600 },
        L,
      ),
    ).toBe("10% quorum · simple majority · 1-hour discussion · 7-day vote");
    expect(
      settingSummary("governance.ordinary", { ...(SEED["governance.ordinary"] as object), votingSeconds: 1_800 }, L),
    ).toContain("30-minute vote");
    expect(
      settingSummary("governance.ordinary", { ...(SEED["governance.ordinary"] as object), votingSeconds: 2 }, L),
    ).toContain("2-second vote");
  });

  it("describes common cron shapes and shows the rest as written", () => {
    expect(describeCron("0 3 1 * *", L)).toBe("Monthly, on day 1 at 03:00 UTC");
    expect(describeCron("30 14 * * 1", L)).toBe("Weekly, on Mondays at 14:30 UTC");
    expect(describeCron("0 0 * * 7", L)).toBe("Weekly, on Sundays at 00:00 UTC");
    expect(describeCron("5 2 * * *", L)).toBe("Daily at 02:05 UTC");
    expect(describeCron("5 * * * *", L)).toBe("Hourly, at minute 5");
    expect(describeCron("*/5 * * * *", L)).toBe("On the schedule */5 * * * *");
    expect(describeCron("0 3 1 6 *", L)).toBe("On the schedule 0 3 1 6 *");
    expect(describeCron("nonsense", L)).toBe("On the schedule nonsense");
    expect(describeCron("0 3 * * 9", L)).toBe("On the schedule 0 3 * * 9");
  });

  it("formats in the member's locale", () => {
    expect(settingSummary("platform.cut", SEED["platform.cut"], "es")).toContain("90");
    expect(formatField(settingFieldSpecs("payout.rules")[0]!, SEED["payout.rules"], "es")).toContain("25,00");
  });
});

describe("unknown keys and malformed values", () => {
  it("an unknown key reads as itself, in the other theme, with flat values as stored", () => {
    expect(isKnownSetting("new.thing")).toBe(false);
    expect(settingTitle("new.thing")).toBe("new.thing");
    expect(settingTheme("new.thing")).toBe("other");
    expect(settingFieldSpecs("new.thing")).toEqual([]);
    expect(settingSummary("new.thing", { a: 1, b: true, c: "x" }, L)).toBe("a: 1 · b: On · c: x");
    expect(settingSummary("new.thing", { nested: { deep: 1200 } }, L)).toBe("nested.deep: 1,200");
    expect(settingSummary("new.thing", 3, L)).toBe("3");
    expect(settingSummary("new.thing", "text", L)).toBe("text");
    expect(settingSummary("new.thing", null, L)).toBe("—");
    expect(settingSummary("new.thing", [1, 2], L)).toBe("1, 2");
    expect(settingSummary("new.thing", [{ a: 1 }], L)).toBe("Custom value (see technical details)");
    expect(settingSummary("new.thing", { list: [{ a: 1 }] }, L)).toBe("Custom value (see technical details)");
    expect(settingSummary("new.thing", {}, L)).toBe("Custom value (see technical details)");
    expect(settingFields("new.thing", { a: 1, b: { c: 2 } }, L)).toEqual([
      { id: "a", label: "a", text: "1" },
      { id: "b.c", label: "b.c", text: "2" },
    ]);
    expect(settingFields("new.thing", 5, L)).toEqual([]);
  });

  it("a known key with a missing field falls back to the fields it has", () => {
    expect(settingSummary("platform.cut", { streamerShare: 0.71 }, L)).toBe("Creator share: 71%");
    expect(settingSummary("discovery.ranking", { spotlightSlots: 4, newChannelBoostDays: 14 }, L)).toBe(
      "Spotlight slots: 4",
    );
  });

  it("a field of the wrong type shows as stored, never as a guess", () => {
    expect(settingSummary("platform.cut", { streamerShare: "ninety", coopShare: 0.1 }, L)).toBe(
      "Creator share: ninety · Co-op share: 10%",
    );
    expect(settingSummary("platform.cut", { streamerShare: { x: 1 } }, L)).toBe(
      "Creator share: Custom value (see technical details)",
    );
    expect(settingSummary("payout.rules", { minimumCents: 25.5, schedule: "monthly", holdDays: 7 }, L)).toContain(
      "Minimum payout: 25.5",
    );
    expect(settingSummary("jury.enabled", { enabled: "yes" }, L)).toBe("On: yes");
    expect(settingSummary("captions.defaultEnabled", { enabled: true }, L)).toBe("On for channels that haven't chosen");
    expect(settingSummary("jury.enabled", { enabled: true }, L)).toBe(
      "On: monthly panels of members review closed cases",
    );
    expect(settingSummary("shares.cardPayments", { enabled: true }, L)).toBe("Members can pay for their share by card");
    expect(settingSummary("council.config", { size: 7, recomputeCron: 5 }, L)).toBe(
      "Seats: 7 · Recomputed (cron schedule): 5",
    );
  });

  it("a known key whose value is not an object reads as stored", () => {
    expect(settingSummary("platform.cut", 0.9, L)).toBe("0.9");
    expect(settingSummary("platform.cut", null, L)).toBe("—");
    expect(settingSummary("platform.cut", [{ a: 1 }], L)).toBe("Custom value (see technical details)");
    expect(settingFields("platform.cut", "x", L)).toEqual([]);
  });

  it("generic values", () => {
    expect(genericValueText(undefined, L)).toBe("—");
    expect(genericValueText(false, L)).toBe("Off");
    expect(genericValueText({ a: 1 }, L)).toBeNull();
    expect(genericValueText(["a", 2, true], L)).toBe("a, 2, On");
  });
});

describe("before → after", () => {
  it("the cut: 90% → 85% on both shares, nothing else", () => {
    const d = settingDiff("platform.cut", SEED["platform.cut"], { streamerShare: 0.85, coopShare: 0.15 }, L);
    expect(d).toMatchObject({
      title: "Creator share of revenue",
      fromSummary: "Creators keep 90% · co-op 10%",
      toSummary: "Creators keep 85% · co-op 15%",
      changed: true,
      otherChanged: false,
    });
    expect(d.fields.map((f) => [f.label, f.from, f.to])).toEqual([
      ["Creator share", "90%", "85%"],
      ["Co-op share", "10%", "15%"],
    ]);
  });

  it("a nested field, a period and an added field", () => {
    const from = SEED["governance.ordinary"] as Record<string, unknown>;
    const d = settingDiff("governance.ordinary", from, { ...from, votingSeconds: 864_000 }, L);
    expect(d.fields.map((f) => [f.id, f.from, f.to])).toEqual([["votingSeconds", "7 days", "10 days"]]);
    const added = settingDiff("platform.cut", { streamerShare: 0.9 }, { streamerShare: 0.9, coopShare: 0.1 }, L);
    expect(added.fields).toEqual([{ id: "coopShare", label: "Co-op share", from: null, to: "10%", changed: true }]);
    const w = SEED["discovery.ranking"] as { weights: Record<string, number> };
    const nested = settingDiff(
      "discovery.ranking",
      w,
      { ...w, weights: { ...w.weights, viewers: 0.3, freshness: 0.3 } },
      L,
    );
    expect(nested.fields.map((f) => f.id)).toEqual(["weights.viewers", "weights.freshness"]);
  });

  it("an unchanged value and a change only to an unknown field", () => {
    expect(settingDiff("platform.cut", SEED["platform.cut"], SEED["platform.cut"], L)).toMatchObject({
      changed: false,
      fields: [],
      otherChanged: false,
    });
    const extra = settingDiff(
      "platform.cut",
      SEED["platform.cut"],
      { ...(SEED["platform.cut"] as object), note: "x" },
      L,
    );
    expect(extra).toMatchObject({ changed: true, fields: [], otherChanged: true });
  });

  it("a known key whose values are not objects", () => {
    expect(settingDiff("platform.cut", 1, 2, L)).toMatchObject({ changed: true, fields: [], otherChanged: true });
  });

  it("unknown keys diff leaf by leaf, complex leaves only in the technical details", () => {
    const d = settingDiff(
      "new.thing",
      { a: 1, b: { c: true }, list: [{ x: 1 }] },
      { a: 2, b: { c: true }, d: "new", list: [] },
      L,
    );
    expect(d.fields.map((f) => [f.id, f.from, f.to])).toEqual([
      ["a", "1", "2"],
      ["d", null, "new"],
    ]);
    expect(d.otherChanged).toBe(true);
    expect(settingDiff("new.thing", 1, 2, L).fields).toEqual([
      { id: "", label: "new.thing", from: "1", to: "2", changed: true },
    ]);
    expect(settingDiff("new.thing", 1, { a: 1 }, L)).toMatchObject({ changed: true });
    expect(settingDiff("new.thing", [{ a: 1 }], [{ a: 2 }], L)).toMatchObject({ fields: [], otherChanged: true });
  });
});

describe("paths and values", () => {
  it("reads and writes nested paths without touching the original", () => {
    const v = { a: { b: 1 } };
    expect(readPath(v, ["a", "b"])).toBe(1);
    expect(readPath(v, ["a", "x"])).toBeUndefined();
    expect(readPath(5, ["a"])).toBeUndefined();
    expect(readPath(v, [])).toBe(v);
    const w = writePath(v, ["a", "c"], 2);
    expect(w).toEqual({ a: { b: 1, c: 2 } });
    expect(v).toEqual({ a: { b: 1 } });
    expect(writePath(null, ["x", "y"], 1)).toEqual({ x: { y: 1 } });
    expect(writePath({ a: 1 }, [], 1)).toEqual({ a: 1 });
  });

  it("compares JSON structurally and lists leaves", () => {
    expect(sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameValue([1], [1, 2])).toBe(false);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(sameValue(1, "1")).toBe(false);
    expect(leafPaths({ a: { b: 1 }, c: [] })).toEqual([["a", "b"], ["c"]]);
    expect(leafPaths(3)).toEqual([[]]);
    expect(leafPaths({})).toEqual([[]]);
  });
});

describe("editing", () => {
  it("percent ↔ fraction without float noise", () => {
    expect(fractionFromPercent(85)).toBe(0.85);
    expect(fractionFromPercent(85.5)).toBe(0.855);
    expect(fractionFromPercent(33.33)).toBe(0.3333);
    expect(percentFromFraction(0.855)).toBe(85.5);
    expect(percentFromFraction(2 / 3)).toBe(66.67);
    expect(complementShare(0.85)).toBe(0.15);
    expect(complementShare(0.9)).toBe(0.1);
  });

  it("the co-op share follows the creator share", () => {
    const [creator] = settingFieldSpecs("platform.cut");
    expect(applyField("platform.cut", SEED["platform.cut"], creator!, 0.85)).toEqual({
      streamerShare: 0.85,
      coopShare: 0.15,
    });
    expect(applyField("platform.cut", SEED["platform.cut"], creator!, "x")).toEqual({
      streamerShare: "x",
      coopShare: 0.1,
    });
    const [quorum] = settingFieldSpecs("governance.ordinary");
    expect(applyField("governance.ordinary", SEED["governance.ordinary"], quorum!, 0.2)).toMatchObject({
      quorum: 0.2,
      threshold: 0.5,
    });
  });

  it("field problems by kind and bound", () => {
    const spec = (key: string, id: string) => settingFieldSpecs(key).find((f) => f.id === id)!;
    const share = spec("platform.cut", "streamerShare");
    expect(fieldError(share, 0.85)).toBeNull();
    expect(fieldError(share, 1.2)).toBe("tooHigh");
    expect(fieldError(share, -0.1)).toBe("tooLow");
    expect(fieldError(share, "x")).toBe("notNumber");
    expect(fieldError(share, null)).toBe("required");
    expect(fieldError(share, undefined)).toBe("required");
    const money = spec("payout.rules", "minimumCents");
    expect(fieldError(money, 25.5)).toBe("notWhole");
    expect(fieldError(money, 2500)).toBeNull();
    expect(fieldError(spec("governance.ordinary", "votingSeconds"), 7_776_001)).toBe("tooHigh");
    expect(fieldError(spec("jury.enabled", "enabled"), "yes")).toBe("required");
    expect(fieldError(spec("jury.enabled", "enabled"), false)).toBeNull();
    expect(fieldError(spec("payout.rules", "schedule"), " ")).toBe("required");
    expect(fieldError(spec("payout.rules", "schedule"), "weekly")).toBeNull();
    expect(fieldError(spec("governance.protections", "protectedKeys"), "anything")).toBeNull();
    expect(fieldBoundText(share, "max", L)).toBe("100%");
    expect(fieldBoundText(spec("governance.ordinary", "threshold"), "min", L)).toBe("50%");
    expect(fieldBoundText(spec("governance.ordinary", "votingSeconds"), "max", L)).toBe("90 days");
    expect(fieldBoundText(spec("payout.rules", "schedule"), "min", L)).toBe("");
  });

  it("the typed editor owns objects of known keys only", () => {
    expect(typedEditable("platform.cut", SEED["platform.cut"])).toBe(true);
    expect(typedEditable("platform.cut", { streamerShare: "x" })).toBe(true);
    expect(typedEditable("platform.cut", 5)).toBe(false);
    expect(typedEditable("platform.cut", [1])).toBe(false);
    expect(typedEditable("new.thing", { a: 1 })).toBe(false);
  });
});
