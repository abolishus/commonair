// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * B8-harness (batch 8 decision (o) and follow-ups): the `e2e-relay` / `relay-dvr` split lost no
 * step, `clock-skew` kept every assertion and waits on coverage, the rate-limited form error is
 * matched through the web catalog in every run locale, and the jury rerun cleanup picks only the
 * harness's own panels.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { PSEUDO_LOCALE, pseudoLocalize } from "../../packages/i18n/src/pseudo.ts";
import { COVERAGE_RULE, coverageReady } from "../scenarios/clock-skew.ts";
import { E2E_RELAY_PHASES } from "../scenarios/e2e-relay.ts";
import { RELAY_DVR_PHASES } from "../scenarios/relay-dvr.ts";
import { B8_EXTENSIONS } from "../src/b8/steps.ts";
import type { ClockSample } from "../src/clock-skew.ts";
import { RELAY_STEPS } from "../src/relay-plan.ts";
import { JURY_CASE_MARKER, type PanelRow, harnessPanelIds, isHarnessJuror } from "../src/w3/jury.ts";
import { W3_EXTENSIONS } from "../src/w3/steps.ts";
import { RATE_LIMITED_KEY, messagePattern, rateLimitedMessage, rateLimitedPattern } from "../src/web/flows.ts";

const source = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

/**
 * Every step, assertion and check title a scenario module names: the first argument of each
 * `.step(`, `assert(` and `check(` call, as written (a string, a template or a title helper call).
 */
function titles(text: string): string[] {
  const re = /(?:\.step|\bassert|\bcheck)\(\s*(`[^`]*`|"[^"]*"|[A-Za-z0-9_]+\([^)]*\))/g;
  return [...text.matchAll(re)].map((m) => m[1] as string);
}

// ------------------------------------------------------------ the relay split

/**
 * `e2e-relay` before the split (main at c389b4e7): every `.step`, `assert` and `check` title of
 * `harness/scenarios/e2e-relay.ts`, in order. The W3 extensions ran through `w3ExtensionTitle`.
 */
const E2E_RELAY_BEFORE = [
  '"sign up the streamer S (API)"',
  '"rotate the stream key"',
  '"S: publish the RTMP test pattern"',
  '"channel goes live (API)"',
  '"relays page starts empty"',
  '"M: API session"',
  '"M: open /relays from relays-link"',
  "`M: create relay ${RELAY_NAME} and read the token`",
  '"relay-run-command carries the token and --public-url"',
  '"M: relay id from relays.mine"',
  '"sign up the member M (API)"',
  "`M: relays.create ${RELAY_NAME}`",
  '"registration token looks like a relay token"',
  '"build the Go relay (cached by source hash)"',
  '"start the Go relay and wait for /healthz"',
  "`relay-row data-status=active within ${RELAY_ACTIVE_TIMEOUT_MS / 1000} s`",
  "`open ${plan.browserViewers} Chromium players on /${channel}`",
  "`${w.label}: reload for a new session (${w.attempts})`",
  "`open sessions until ${plan.minRelayAssigned} are relay-assigned`",
  "`at least ${plan.minRelayAssigned} honest sessions are relay-assigned`",
  '"honest HTTP viewers play"',
  '"every honest HTTP viewer plays"',
  '"every Chromium player is playing"',
  '"relay /healthz reports viewers ≥ 2"',
  "`start ${plan.bots} viewbots`",
  '"receipts: verified ≥ 1, bytes verified > 0"',
  '"no rejected receipts for the honest relay"',
  '"counts: verified = honest, excluded ≥ bots"',
  '"the public count never exceeded the honest count"',
  'w3ExtensionTitle(name, "run")',
  "`M: relays.create ${LIAR_NAME}`",
  '"start the liar relay and register it"',
  '"liar relay active"',
  "`open HTTP viewers until ${plan.liarViewers} land on the liar`",
  "`at least ${plan.liarViewers} sessions landed on the liar`",
  '"the liar serves its viewers (pass-through)"',
  '"liar-assigned viewers play through the liar"',
  '"liar: relay-row data-status=suspended with a reason"',
  '"the liar\'s receipts were rejected"',
  '"the API accepted the liar\'s signed receipts for checking"',
  '"liar-assigned viewers move to the origin"',
  '"every liar-assigned viewer switched to the origin"',
  '"switched viewers keep playing from the origin"',
  '"honest − liar-assigned ≤ verified ≤ honest"',
  '"the public count never exceeded the honest count"',
  "`SIGTERM: relay-row data-status=offline within ${DRAIN_OFFLINE_TIMEOUT_MS / 1000} s`",
  "`${b.label}: data-source=origin and playing within ${DRAIN_SWITCH_TIMEOUT_MS / 1000} s`",
  '"relay-assigned HTTP viewers switched to the origin"',
  '"the relay exits after its drain"',
  '"the relay exited cleanly"',
  '"restart the relay with the same token"',
  '"relay back to active"',
  "`M: retire ${RELAY_NAME}`",
  '"relays.mine omits the retired relay"',
  '"stop the retired relay"',
  '"stop viewers and bots"',
  '"stop publishing"',
  '"channel goes offline (API)"',
  '"relay-assigned honest sessions are in Postgres"',
  '"relay-assigned honest sessions are verified (on receipts)"',
];
/** The W3 extensions `e2e-relay` ran before the split. */
const W3_RELAY_BEFORE = ["dvr-relay", "dvr-purge", "relay-vtt"];

describe("the e2e-relay / relay-dvr split", () => {
  const e2e = source("scenarios/e2e-relay.ts");
  const dvr = source("scenarios/relay-dvr.ts");
  // `w3/steps.ts` keys the extensions by scenario; read both keys, whichever holds them.
  const w3Of = (s: string): readonly string[] =>
    (W3_EXTENSIONS as Readonly<Record<string, readonly string[]>>)[s] ?? [];

  test("the scenarios' titles together are every title e2e-relay had", () => {
    const after = new Set([...titles(e2e), ...titles(dvr)]);
    expect(E2E_RELAY_BEFORE.filter((t) => !after.has(t))).toEqual([]);
  });

  test("the W3 extensions moved whole to relay-dvr, which runs each one and B8's switch", () => {
    expect([...w3Of("e2e-relay"), ...w3Of("relay-dvr")].sort()).toEqual([...W3_RELAY_BEFORE].sort());
    expect(e2e).not.toMatch(/w3Extensions\(|stepDvrRelay|stepDvrPurge|stepRelayVtt/);
    expect(dvr).toContain('w3Extensions("relay-dvr", ctx.param("w3", ""))');
    expect(dvr).toContain("W3_STEPS[name]");
    for (const e of W3_RELAY_BEFORE) expect(dvr).toContain(`"${e}":`);
    expect(B8_EXTENSIONS["relay-dvr"]).toEqual(["relay-dvr-switch"]);
    expect(dvr).toContain('b8Extensions("relay-dvr", ctx.param("b8", ""))');
    expect(dvr).toContain('"relay-dvr-switch": stepRelayDvrSwitch');
  });

  test("the phases of the two scenarios cover the plan's, and only relay-dvr takes DVR", () => {
    const phases = new Set<string>([...E2E_RELAY_PHASES, ...RELAY_DVR_PHASES]);
    for (const step of Object.values(RELAY_STEPS)) expect(phases.has(step), step).toBe(true);
    expect(E2E_RELAY_PHASES).toEqual(Object.values(RELAY_STEPS));
    expect(RELAY_DVR_PHASES).toEqual(["setup", "dvr through the relay", "relay switch mid-DVR"]);
  });

  test("each scenario stands its relay up itself, so either runs alone", () => {
    expect(e2e).toMatch(/export async function setUpRelay\(/);
    expect(e2e).toMatch(/const base = await setUpRelay\(ctx, plan, run\)/);
    expect(dvr).toMatch(/const base = await setUpRelay\(ctx, plan, run\)/);
    // relay-dvr runs no step of e2e-relay's sections 2 to 6 (the viewers, bots, liar and drain).
    for (const t of ["counts: verified = honest", "liar relay active", "the relay exits after its drain"])
      expect(dvr).not.toContain(t);
  });
});

// ------------------------------------------------------------ clock-skew

/** `clock-skew` before the trim (main at c389b4e7): every assertion and check it made. */
const CLOCK_ASSERTIONS_BEFORE = [
  "`${r.protocol}: the ladder ran (rungs sampled)`",
  "`${r.protocol}: cross-rendition skew p95 < ${CROSS_RENDITION_P95_MS} ms`",
  "`${r.protocol}: live-to-VOD skew p95 < ${LIVE_TO_VOD_P95_MS} ms`",
  '`${c.protocol}: every rendition present ≥ 2 min${c.protocol === "rtmp" ? ", incl. the minute after the ladder restart" : ""}`',
  "`${tag}: broadcast id known`",
  "`${tag}: the recorder's ffmpeg was ended once`",
];

describe("clock-skew", () => {
  const text = source("scenarios/clock-skew.ts");
  const T = 1_793_000_000_000;
  /** One sample of `rendition` every 2 s over `[fromS, toS)` seconds. */
  const run = (rendition: string, fromS: number, toS: number): ClockSample[] =>
    Array.from({ length: Math.ceil((toS - fromS) / 2) }, (_, i) => ({
      rendition,
      stripMs: T + (fromS + i * 2) * 1000,
      pdtMs: T + (fromS + i * 2) * 1000,
    }));

  test("every assertion and check is kept", () => {
    const after = new Set(titles(text));
    expect(CLOCK_ASSERTIONS_BEFORE.filter((t) => !after.has(t))).toEqual([]);
  });

  test("no measurement window is a fixed sleep any more", () => {
    expect(text).not.toMatch(/Bun\.sleep\(/);
    expect(text).toMatch(/coverageReady\(/);
  });

  test("the coverage the check judges is the rule the windows wait for", () => {
    expect(COVERAGE_RULE).toEqual({
      minTotalMs: 120_000,
      afterRestartMs: 60_000,
      afterRestartFraction: 0.8,
      gapMs: 5_000,
    });
  });

  test("ready once every rendition is covered long enough, never before a rung is sampled", () => {
    const rule = { ...COVERAGE_RULE, minTotalMs: 30_000, restartAt: null };
    expect(coverageReady(run("source", 0, 40), ["source"], rule)).toBe(false);
    expect(coverageReady([...run("source", 0, 40), ...run("720p", 0, 20)], ["source", "720p"], rule)).toBe(false);
    expect(coverageReady([...run("source", 0, 40), ...run("720p", 0, 34)], ["source", "720p"], rule)).toBe(true);
    // A rendition advertised but never sampled holds the window open.
    expect(coverageReady([...run("source", 0, 40), ...run("720p", 0, 34)], ["480p", "source", "720p"], rule)).toBe(
      false,
    );
  });

  test("after a ladder restart: ready once 80 % of the minute after it is covered", () => {
    const restartAt = T + 100_000;
    const rule = { ...COVERAGE_RULE, minTotalMs: 0, restartAt };
    const src = run("source", 90, 170);
    expect(coverageReady([...src, ...run("720p", 100, 140)], ["source", "720p"], rule)).toBe(false);
    expect(coverageReady([...src, ...run("720p", 100, 152)], ["source", "720p"], rule)).toBe(true);
    // A gap past `gapMs` does not count as covered.
    const gappy = [...run("720p", 100, 120), ...run("720p", 130, 152)];
    expect(coverageReady([...src, ...gappy], ["source", "720p"], rule)).toBe(false);
  });
});

// ------------------------------------------------------------ the rate-limited form error

const catalog = (lang: string) =>
  JSON.parse(source(`../apps/web/src/i18n/locales/${lang}/core.json`)) as Record<string, string>;

describe("the rate-limited form error through the catalog", () => {
  const en = catalog("en")[RATE_LIMITED_KEY] as string;
  const es = catalog("es")[RATE_LIMITED_KEY] as string;

  test("the catalogs have the key", () => {
    expect(typeof en).toBe("string");
    expect(typeof es).toBe("string");
    expect(es).not.toBe(en);
  });

  test("each run locale reads its own message", () => {
    expect(rateLimitedMessage("en")).toBe(en);
    expect(rateLimitedMessage("en-US")).toBe(en);
    expect(rateLimitedMessage("es")).toBe(es);
    expect(rateLimitedMessage("es-MX")).toBe(es);
    expect(rateLimitedMessage(PSEUDO_LOCALE)).toBe(pseudoLocalize(en));
    expect(rateLimitedMessage(null)).toBe(en);
  });

  test("the pattern for a locale matches its form error and not another locale's", () => {
    const form = (m: string) => `form error: ${m}`;
    expect(rateLimitedPattern("en").test(form(en))).toBe(true);
    expect(rateLimitedPattern("es").test(form(es))).toBe(true);
    expect(rateLimitedPattern(PSEUDO_LOCALE).test(form(pseudoLocalize(en)))).toBe(true);
    expect(rateLimitedPattern("es").test(form(en))).toBe(false);
    expect(rateLimitedPattern("en").test(form(es))).toBe(false);
    expect(rateLimitedPattern(PSEUDO_LOCALE).test(form(en))).toBe(false);
    expect(rateLimitedPattern("en").test(form("Wrong email or password."))).toBe(false);
  });

  test("a locale without the key falls back to English, with a warning", () => {
    const warnings: unknown[] = [];
    expect(rateLimitedMessage("fr", (msg, fields) => warnings.push({ msg, fields }))).toBe(en);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ fields: { locale: "fr", key: RATE_LIMITED_KEY } });
    expect(rateLimitedMessage("en", () => warnings.push("en"))).toBe(en);
    expect(warnings).toHaveLength(1);
  });

  test("literal text is escaped and placeholders become wildcards", () => {
    const p = messagePattern("Wait {seconds, plural, one {# second} other {# seconds}} (or {who}). [Try?]");
    expect(p.test("Wait 30 seconds (or you). [Try?]")).toBe(true);
    expect(p.test("Wait 1 second (or the bot). [Try?]")).toBe(true);
    expect(p.test("Wait 30 seconds (or you). Try")).toBe(false);
    expect(messagePattern("a.b").test("axb")).toBe(false);
    expect(messagePattern("$1 * (2)").test("costs $1 * (2) now")).toBe(true);
    // The pseudo-locale keeps placeholders, so its pattern wildcards them too.
    const pseudo = pseudoLocalize("Too many attempts for {email}.");
    expect(messagePattern(pseudo).test(pseudo.replace("{email}", "someone@example.test"))).toBe(true);
  });
});

// ------------------------------------------------------------ the jury rerun cleanup

describe("the jury rerun cleanup", () => {
  const panel = (id: string, seats: string[], cases: number, markedCases: number): PanelRow => ({
    id,
    seats,
    cases,
    markedCases,
  });

  test("the marker and the members' prefix", () => {
    expect(JURY_CASE_MARKER).toBe("harness:e5-coop:jury");
    expect(isHarnessJuror("e5_jury_ab12")).toBe(true);
    expect(isHarnessJuror("e5_juryman")).toBe(false);
    expect(isHarnessJuror("alice")).toBe(false);
  });

  test("a harness panel with other members seated is the harness's (the case the old rule missed)", () => {
    const mixed = panel("p1", ["alice", "e5_jury_a", "e5_jury_b", "seed_member"], 9, 7);
    expect(harnessPanelIds([mixed])).toEqual(["p1"]);
  });

  test("only harness panels are chosen", () => {
    const rows = [
      panel("harness", ["e5_jury_a", "e5_jury_b"], 6, 6),
      panel("harness-mixed", ["bob", "e5_jury_c"], 10, 2),
      // Real panels: real seats on real cases, harness cases sampled by a real draw, or a harness
      // member seated (left opted in) on real cases.
      panel("real", ["alice", "bob", "carol"], 12, 0),
      panel("real-on-harness-cases", ["alice", "bob"], 8, 3),
      panel("real-with-a-stray-juror", ["alice", "e5_jury_d"], 8, 0),
      // Committed but never selected: the next draw reuses it.
      panel("empty", [], 0, 0),
    ];
    expect(harnessPanelIds(rows)).toEqual(["harness", "harness-mixed"]);
    expect(harnessPanelIds([])).toEqual([]);
  });

  test("the cleanup reads the marker off the cases and deletes by id only", () => {
    const text = source("src/w3/jury.ts");
    expect(text).toContain("mc.resolution_note = ${JURY_CASE_MARKER} or r.details = ${JURY_CASE_MARKER}");
    expect(text).toContain('delete from jury_panels where id = any(${sql.array(ids, "uuid")})');
    // The seed writes the marker on every moderation case and report it creates.
    expect(text).toContain("resolution_note = ${JURY_CASE_MARKER}");
    expect(text).toMatch(/insert into reports \([^)]*details[^)]*\)/);
  });
});
