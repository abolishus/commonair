// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure helpers of `trust-safety` step 8 (DMCA). */
import { DMCA_RULES } from "@commonair/contracts/enums";
import { describe, expect, test } from "vite-plus/test";
import {
  DMCA_AUDIT_ORDER,
  DMCA_HIDDEN_PREFIX,
  addWeekdaysUtc,
  claimantFor,
  counterFieldsFor,
  dmcaTickTimes,
  inOrder,
  mediaKeyOf,
  restoreAfterOk,
} from "../../src/e7/dmca.ts";

const ms = (iso: string) => Date.parse(iso);

describe("restore-after", () => {
  test("12 weekdays, weekends skipped (Monday, Friday, Saturday starts)", () => {
    expect(DMCA_RULES.restoreWeekdays).toBe(12);
    expect(new Date(addWeekdaysUtc(ms("2026-10-26T09:15:00Z"), 12)).toISOString()).toBe("2026-11-11T09:15:00.000Z");
    expect(new Date(addWeekdaysUtc(ms("2026-10-30T09:15:00Z"), 12)).toISOString()).toBe("2026-11-17T09:15:00.000Z");
    expect(new Date(addWeekdaysUtc(ms("2026-10-31T09:15:00Z"), 12)).toISOString()).toBe("2026-11-17T09:15:00.000Z");
  });

  test("accepts the API's date for a filing inside the round trip, refuses anything else", () => {
    const before = ms("2026-10-27T10:00:00Z");
    const after = before + 800;
    const ok = new Date(addWeekdaysUtc(before + 400, 12)).toISOString();
    expect(restoreAfterOk(before, after, ok)).toBe(true);
    expect(restoreAfterOk(before, after, new Date(addWeekdaysUtc(before, 11)).toISOString())).toBe(false);
    expect(restoreAfterOk(before, after, new Date(addWeekdaysUtc(before, 13)).toISOString())).toBe(false);
    expect(restoreAfterOk(before, after, "not a date")).toBe(false);
  });

  test("ticks one minute either side", () => {
    expect(dmcaTickTimes("2026-11-12T10:00:00.000Z")).toEqual({
      before: "2026-11-12T09:59:00.000Z",
      after: "2026-11-12T10:01:00.000Z",
    });
  });
});

describe("audit order", () => {
  test("the four steps in order, others allowed in between", () => {
    expect(
      inOrder(
        ["dmca.notice.submit", "x", "dmca.notice.action", "dmca.counter.receive", "dmca.content.restore"],
        DMCA_AUDIT_ORDER,
      ),
    ).toBe(true);
    expect(
      inOrder(
        ["dmca.notice.action", "dmca.notice.submit", "dmca.counter.receive", "dmca.content.restore"],
        DMCA_AUDIT_ORDER,
      ),
    ).toBe(false);
    expect(inOrder(["dmca.notice.submit", "dmca.notice.action", "dmca.counter.receive"], DMCA_AUDIT_ORDER)).toBe(false);
  });
});

describe("media keys", () => {
  test("a clip URL's object key, and the private prefix is not publicly routed", () => {
    expect(mediaKeyOf("http://localhost:8080/media/clips/0192f000-0000-7000-8000-000000000001.mp4")).toBe(
      "clips/0192f000-0000-7000-8000-000000000001.mp4",
    );
    expect(mediaKeyOf("http://localhost:8080/elsewhere")).toBeNull();
    for (const p of ["channels/", "clips/", "thumbnails/", "vods/"])
      expect(DMCA_HIDDEN_PREFIX.startsWith(p)).toBe(false);
  });
});

describe("synthetic people", () => {
  test("run-unique, lower-case email on the harness domain, contract-sized phone", () => {
    const c = claimantFor("RUN1", 1, "Harness.Test", ["https://x.test/a/clip/b"]);
    expect(c.email).toBe("dmca_run1_1@harness.test");
    expect(c.phone.length).toBeGreaterThanOrEqual(5);
    expect(c.phone.length).toBeLessThanOrEqual(40);
    expect(c.name).toContain("RUN1");
    const f = counterFieldsFor("RUN1", 2);
    expect(f.statement).toContain("RUN1");
    expect(f.phone).not.toBe(c.phone);
  });
});
