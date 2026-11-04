// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { decodeCue, decodeLiveTrack } from "@commonair/captions";
import { describe, expect, test } from "vite-plus/test";
import {
  captionFixture,
  dvrPurgePrefix,
  fetchedThrough,
  FIXTURE_CUE_TEXT,
  RECEIPT_EDGE_SLACK_MS,
  receiptCoverage,
  receiptTotals,
  servedBy,
  vttCacheControlOk,
} from "../../src/w3/dvr-relay/checks.ts";
import { stepDvrPurge, stepDvrRelay, stepRelayVtt } from "../../src/w3/dvr-relay/index.ts";

const SID = "0192f3a4-5b6c-7d8e-9f01-00000000dd01";
const OTHER = "0192f3a4-5b6c-7d8e-9f01-00000000dd02";

describe("receiptTotals", () => {
  test("sums one session's entries across receipts and ignores the rest", () => {
    const payloads = [
      {
        entries: [
          { sessionId: SID, segments: 3, bytes: 300 },
          { sessionId: OTHER, segments: 9, bytes: 900 },
        ],
      },
      { entries: [{ sessionId: SID, segments: 2, bytes: 200 }] },
      { entries: [] },
      null,
      "garbage",
      { entries: [{ sessionId: SID, segments: "5", bytes: Number.NaN }] },
    ];
    expect(receiptTotals(payloads, SID)).toEqual({ segments: 5, bytes: 500 });
    expect(receiptTotals(payloads, "nobody")).toEqual({ segments: 0, bytes: 0 });
    expect(receiptTotals([], SID)).toEqual({ segments: 0, bytes: 0 });
  });
});

describe("receiptCoverage and fetchedThrough", () => {
  // CI run 41357496846: the viewer started 22:43:18 and fetched 19 segments in its 60 s; the relay
  // cut at 22:43:32.7 (8 of them) and next at 22:44:32.7, but the step read at 22:44:18 and compared
  // the 8 with all 19. Compared with the fetches the newest cut covers, the receipts hold.
  const at = (hms: string) => Date.parse(`2026-11-01T${hms}Z`);
  const viewerStart = at("22:43:18.300");
  const doneAt = [
    0, 0.4, 0.8, 1.2, 4.3, 8.3, 12.3, 13.9, 18.3, 22.3, 26.3, 30.3, 34.3, 38.3, 42.3, 46.3, 50.3, 54.3, 58.3,
  ].map((s) => viewerStart + s * 1000);
  const first = {
    payload: { entries: [{ sessionId: SID, segments: 8, bytes: 3_428_497 }] },
    endMs: at("22:43:32.707"),
  };
  const other = { payload: { entries: [{ sessionId: OTHER, segments: 40, bytes: 1 }] }, endMs: at("22:42:32.700") };

  test("before the next cut: the receipts cover the fetches up to the newest cut, which they credit", () => {
    const c = receiptCoverage([other, first], SID);
    expect(c).toEqual({ segments: 8, bytes: 3_428_497, throughMs: first.endMs });
    expect(fetchedThrough(doneAt, c.throughMs)).toBe(8);
    expect(doneAt.length).toBe(19);
  });

  test("after the next cut the bar moves with it", () => {
    const second = { payload: { entries: [{ sessionId: SID, segments: 13, bytes: 5 }] }, endMs: at("22:44:32.698") };
    const c = receiptCoverage([first, second, other], SID);
    expect(c.segments).toBe(21);
    expect(c.throughMs).toBe(second.endMs);
    expect(fetchedThrough(doneAt, c.throughMs)).toBe(19);
  });

  test("a relay that drops a counted fetch fails the comparison", () => {
    const short = { ...first, payload: { entries: [{ sessionId: SID, segments: 7, bytes: 1 }] } };
    const c = receiptCoverage([short], SID);
    expect(c.segments).toBeLessThan(fetchedThrough(doneAt, c.throughMs));
  });

  test("a fetch finished within the edge slack of a cut is left to the next period", () => {
    expect(fetchedThrough([1_000, 9_600, 9_400], 10_000)).toBe(2);
    expect(fetchedThrough([10_000 - RECEIPT_EDGE_SLACK_MS], 10_000)).toBe(1);
    expect(fetchedThrough([], 10_000)).toBe(0);
  });

  test("no receipts: nothing credited, through 0, no fetch covered", () => {
    const c = receiptCoverage([], SID);
    expect(c).toEqual({ segments: 0, bytes: 0, throughMs: 0 });
    expect(fetchedThrough(doneAt, c.throughMs)).toBe(0);
    expect(receiptCoverage([{ payload: null, endMs: Number.NaN }], SID).throughMs).toBe(0);
  });
});

describe("vttCacheControlOk", () => {
  test("max-age=30 without immutable", () => {
    expect(vttCacheControlOk("private, max-age=30")).toBe(true);
    expect(vttCacheControlOk("Public, Max-Age=30")).toBe(true);
    expect(vttCacheControlOk("private, max-age=86400, immutable")).toBe(false);
    expect(vttCacheControlOk("private, max-age=30, immutable")).toBe(false);
    expect(vttCacheControlOk("private, max-age=300")).toBe(false);
    expect(vttCacheControlOk(null)).toBe(false);
  });
});

describe("servedBy", () => {
  test("same origin only", () => {
    expect(servedBy("http://10.0.0.2:8099/dvr/x/index.m3u8?t=a", "http://10.0.0.2:8099")).toBe(true);
    expect(servedBy("http://10.0.0.2:8098/dvr/x/index.m3u8", "http://10.0.0.2:8099")).toBe(false);
    expect(servedBy("http://origin.test/dvr/x/index.m3u8", "http://10.0.0.2:8099")).toBe(false);
    expect(servedBy(null, "http://10.0.0.2:8099")).toBe(false);
    expect(servedBy("not a url", "http://10.0.0.2:8099")).toBe(false);
  });
});

describe("captionFixture", () => {
  test("a track the origin decodes, one 2 s cue per 3 s segment over the window", () => {
    const now = Date.parse("2026-11-01T12:00:00.000Z");
    const f = captionFixture("0192f3a4-5b6c-7d8e-9f01-00000000bb01", now, 30);
    expect(f.liveKey).toBe("captions:live:0192f3a4-5b6c-7d8e-9f01-00000000bb01");
    expect(f.cuesKey).toBe("captions:cues:0192f3a4-5b6c-7d8e-9f01-00000000bb01:en");
    const track = decodeLiveTrack(f.track);
    expect(track).toEqual({ language: "en", w0Ms: now - 30_000, anchorMs: now - 30_000, throughMs: now });
    expect(f.cues).toHaveLength(10);
    for (const [score, member] of f.cues) {
      const cue = decodeCue(member);
      expect(cue?.startMs).toBe(score);
      expect(cue && cue.endMs - cue.startMs).toBe(2000);
      expect(cue?.text.startsWith(FIXTURE_CUE_TEXT)).toBe(true);
      expect(score + 2000).toBeLessThanOrEqual(now);
    }
    // Members are unique even with identical timing (the `n` field).
    expect(new Set(f.cues.map(([, m]) => m)).size).toBe(f.cues.length);
  });
});

test("the purge prefix is the relay's DVR cache tree", () => {
  expect(dvrPurgePrefix("0192f3a4-5b6c-7d8e-9f01-00000000aa01")).toBe("dvr/0192f3a4-5b6c-7d8e-9f01-00000000aa01/");
});

test("the three steps are real (no stub left)", async () => {
  const src = await Bun.file(new URL("../../src/w3/dvr-relay/index.ts", import.meta.url)).text();
  expect(src).not.toContain("not merged");
  expect([stepDvrRelay, stepDvrPurge, stepRelayVtt].every((f) => typeof f === "function")).toBe(true);
});

/**
 * Run 41757992200 (`relay-dvr` alone): the DVR session stayed `pending` (`fetch_unjudged`,
 * `media_unconfirmed`) for the whole 300 s. The origin's relay issuance counts only the live media
 * it pulled from MediaMTX (`services/origin/src/issuance.ts`), so a minute whose only relay session
 * is a DVR one on a channel nobody watches live is an issuance gap: the receipt verifies as
 * issuance-unknown, proves nothing, and the session has no receipt coverage. Inside `e2e-relay` the
 * relay's live audience hid that. The step keeps a live viewer on its own channel from before the
 * DVR viewer starts until that viewer stops (`dvr-purge`), and judges the verdict once, in between.
 */
describe("dvr-relay keeps its channel's live production recorded while it judges the DVR session", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  const src = read("../../src/w3/dvr-relay/index.ts");
  const body = (name: string) => {
    const from = src.indexOf(`export async function ${name}(`);
    const to = src.indexOf("\nexport async function ", from + 1);
    return src.slice(from, to === -1 ? undefined : to);
  };
  const relay = body("stepDvrRelay");
  const purge = body("stepDvrPurge");
  const VERDICT = '"the session verifies (scored, on receipts)"';

  test("a live HTTP viewer of the DVR channel starts before the DVR viewer", () => {
    const live = relay.search(/new HttpViewer\(\{[^}]*target: \{ channel: ch\.channel \}/);
    expect(live).toBeGreaterThan(-1);
    expect(live).toBeLessThan(relay.indexOf("new DvrHttpViewer("));
  });

  test("it is still watching when the verdict is judged, and leaves with the DVR viewer", () => {
    expect(relay).toContain(VERDICT);
    expect(relay).not.toMatch(/\blive\.stop\(\)/);
    expect(purge).toMatch(/run\.viewer\.stop\(\)[\s\S]{0,80}run\.live\.stop\(\)/);
  });

  test("the verdict is judged only in dvr-relay, never after relay-dvr's teardown", () => {
    expect(src.split(VERDICT).length - 1).toBe(relay.split(VERDICT).length - 1);
    // The scenario's own body after the extensions is teardown only (no verdict read there).
    expect(read("../../scenarios/relay-dvr.ts")).not.toMatch(/playback_sessions|verdict|\(scored/);
  });
});
