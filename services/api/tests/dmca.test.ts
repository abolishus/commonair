// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure DMCA rules (17 U.S.C. § 512; not reviewed by a lawyer): the restore date, URL
 * de-duplication, the repeat-infringer threshold, and the owner DTO that must never carry the
 * claimant's contact details.
 */
import { DMCA_RULES } from "@commonair/contracts/enums";
import * as D from "@commonair/contracts/dto";
import { describe, expect, test } from "vite-plus/test";
import { toOwnerNotice, toStaffNotice, type CounterRow, type ItemRow, type NoticeRow } from "../src/dmca/dto.ts";
import {
  addWeekdays,
  dedupeUrls,
  isRepeatInfringer,
  normalizeUrl,
  repeatInfringerOutcome,
  restoreAfter,
  weekdaysBetween,
} from "../src/dmca/rules.ts";

const day = (iso: string) => new Date(iso).getUTCDay();

describe("addWeekdays / restoreAfter (§ 512(g)(2)(C): 10 to 14 business days)", () => {
  // 2026-10-26 is a Monday.
  const cases: [string, string][] = [
    ["2026-10-26T09:15:00.000Z", "2026-11-11T09:15:00.000Z"], // Monday
    ["2026-10-27T09:15:00.000Z", "2026-11-12T09:15:00.000Z"], // Tuesday
    ["2026-10-28T09:15:00.000Z", "2026-11-13T09:15:00.000Z"], // Wednesday
    ["2026-10-29T09:15:00.000Z", "2026-11-16T09:15:00.000Z"], // Thursday
    ["2026-10-30T09:15:00.000Z", "2026-11-17T09:15:00.000Z"], // Friday filing
    ["2026-10-31T09:15:00.000Z", "2026-11-17T09:15:00.000Z"], // Saturday counts from Monday
    ["2026-11-01T09:15:00.000Z", "2026-11-17T09:15:00.000Z"], // Sunday counts from Monday
  ];
  test.each(cases)("12 weekdays after %s is %s", (from, to) => {
    expect(addWeekdays(new Date(from), 12).toISOString()).toBe(to);
    expect(restoreAfter(new Date(from)).toISOString()).toBe(to);
  });

  test("the rule is 12 weekdays", () => {
    expect(DMCA_RULES.restoreWeekdays).toBe(12);
  });

  test("across the year end", () => {
    // Thursday 31 December 2026 → Monday 18 January 2027 (1 January is a weekday: holidays are not modelled).
    expect(addWeekdays(new Date("2026-12-31T23:59:59.000Z"), 12).toISOString()).toBe("2027-01-18T23:59:59.000Z");
  });

  test("UTC only: a daylight-saving change in the window does not move the time of day", () => {
    // US DST ends 1 November 2026 and starts 14 March 2027; UTC has neither.
    for (const from of ["2026-10-28T23:30:00.000Z", "2027-03-10T00:30:00.000Z"]) {
      const to = addWeekdays(new Date(from), 12);
      expect(to.toISOString().slice(11)).toBe(from.slice(11));
    }
  });

  test("every start in a year lands on a weekday, 12 weekdays later, never sooner than 14 calendar days", () => {
    for (let i = 0; i < 366; i++) {
      const from = new Date(Date.UTC(2026, 0, 1, 12) + i * 86_400_000);
      const to = restoreAfter(from);
      expect([1, 2, 3, 4, 5]).toContain(day(to.toISOString()));
      expect(weekdaysBetween(from, to)).toBe(12);
      const calendarDays = Math.round((to.getTime() - from.getTime()) / 86_400_000);
      expect(calendarDays).toBeGreaterThanOrEqual(14);
      expect(calendarDays).toBeLessThanOrEqual(18);
    }
  });

  test("zero is the same instant; negative or fractional counts are refused", () => {
    const d = new Date("2026-10-26T00:00:00Z");
    expect(addWeekdays(d, 0).getTime()).toBe(d.getTime());
    expect(() => addWeekdays(d, -1)).toThrow(RangeError);
    expect(() => addWeekdays(d, 1.5)).toThrow(RangeError);
  });
});

describe("URL normalisation and de-duplication", () => {
  test("fragments, trailing slashes, host case and whitespace collapse to one URL", () => {
    expect(
      dedupeUrls([
        "https://Air.Example.test/ada/clip/abc",
        " https://air.example.test/ada/clip/abc/ ",
        "https://air.example.test/ada/clip/abc#t=10",
        "https://air.example.test/ada/clip/abc?x=1",
        "",
        "   ",
      ]),
    ).toEqual(["https://air.example.test/ada/clip/abc", "https://air.example.test/ada/clip/abc?x=1"]);
  });

  test("keeps first-seen order and leaves the root path alone", () => {
    expect(dedupeUrls(["https://b.test/", "https://a.test/x", "https://b.test"])).toEqual([
      "https://b.test/",
      "https://a.test/x",
    ]);
  });

  test("something that is not a URL is kept as typed", () => {
    expect(normalizeUrl("  not a url ")).toBe("not a url");
    expect(dedupeUrls(["not a url", "not a url "])).toEqual(["not a url"]);
  });
});

describe("repeat infringers (§ 512(i)(1)(A))", () => {
  test("terminates at and over the threshold, once", () => {
    expect(repeatInfringerOutcome(0, false, 3)).toBe("none");
    expect(repeatInfringerOutcome(2, false, 3)).toBe("none");
    expect(repeatInfringerOutcome(3, false, 3)).toBe("terminate");
    expect(repeatInfringerOutcome(4, false, 3)).toBe("terminate");
    expect(repeatInfringerOutcome(4, true, 3)).toBe("none");
  });

  test("threshold 0 turns the suspension off: every strike only notifies moderators", () => {
    expect(repeatInfringerOutcome(1, false, 0)).toBe("notify");
    expect(repeatInfringerOutcome(10, false, 0)).toBe("notify");
    expect(repeatInfringerOutcome(0, false, 0)).toBe("none");
    expect(isRepeatInfringer(10, 0)).toBe(false);
  });

  test("threshold 1: the first strike terminates", () => {
    expect(repeatInfringerOutcome(1, false, 1)).toBe("terminate");
    expect(isRepeatInfringer(1, 1)).toBe(true);
  });

  test("the staff flag matches the default threshold", () => {
    expect(isRepeatInfringer(DMCA_RULES.repeatInfringerStrikes - 1)).toBe(false);
    expect(isRepeatInfringer(DMCA_RULES.repeatInfringerStrikes)).toBe(true);
    expect(repeatInfringerOutcome(DMCA_RULES.repeatInfringerStrikes, false)).toBe("terminate");
  });
});

describe("DTOs", () => {
  const at = new Date("2026-10-27T10:00:00Z");
  const notice: NoticeRow = {
    id: "0192f000-0000-7000-8000-000000000001",
    claimantName: "Claire Claimant",
    claimantEmail: "claire@example.test",
    claimantAddress: "1 Rights Road",
    claimantPhone: "+1 555 0100",
    copyrightedWork: "My song",
    infringingUrls: ["https://air.example.test/ada/clip/x"],
    goodFaithStatement: true,
    accuracyStatement: true,
    signature: "Claire C. Signature",
    status: "actioned",
    handledById: "0192f000-0000-7000-8000-000000000009",
    decisionNote: "ok",
    createdAt: at,
    actionedAt: at,
  };
  const item = (id: string, ownerId: string): ItemRow => ({
    id,
    noticeId: notice.id,
    url: "https://air.example.test/ada/clip/x",
    subjectType: "clip",
    subjectId: "0192f000-0000-7000-8000-0000000000c1",
    ownerId,
    channelId: "0192f000-0000-7000-8000-0000000000c2",
    removedAt: at,
    objectsHiddenAt: null,
    restoredAt: null,
    createdAt: at,
  });
  const counter: CounterRow = {
    id: "0192f000-0000-7000-8000-0000000000cc",
    noticeId: notice.id,
    userId: "0192f000-0000-7000-8000-0000000000a1",
    fullName: "Ada",
    address: "2 Uploader Lane",
    phone: "+1 555 0200",
    itemIds: ["0192f000-0000-7000-8000-0000000000e1"],
    statement: "mistake",
    goodFaithStatement: true,
    consentToJurisdiction: true,
    signature: "Ada",
    restoreAfter: restoreAfter(at),
    restoredAt: null,
    suitFiledAt: null,
    suitRecordedById: null,
    suitNote: null,
    createdAt: at,
  };

  test("the owner view carries the claimant's name only, and validates against the contract", () => {
    const dto = toOwnerNotice(notice, [item("0192f000-0000-7000-8000-0000000000e1", counter.userId)], counter);
    expect(D.DmcaNoticeForOwner.parse(dto)).toEqual(dto);
    const json = JSON.stringify(dto);
    for (const secret of [notice.claimantEmail, notice.claimantAddress, notice.claimantPhone, notice.signature])
      expect(json).not.toContain(secret);
    expect(json).not.toContain(counter.address);
    expect(json).not.toContain(counter.phone);
    expect(dto.claimantName).toBe(notice.claimantName);
    expect(dto.counter).toEqual({
      id: counter.id,
      restoreAfter: counter.restoreAfter.toISOString(),
      restoredAt: null,
      suitFiledAt: null,
    });
  });

  test("the staff view is the full contract shape", () => {
    const dto = toStaffNotice(
      notice,
      [item("0192f000-0000-7000-8000-0000000000e1", counter.userId)],
      [{ row: counter, user: { id: counter.userId, username: "ada" } }],
      { [counter.userId]: 1 },
      { id: "0192f000-0000-7000-8000-000000000009", username: "mod" },
    );
    expect(D.DmcaNotice.parse(dto)).toEqual(dto);
    expect(dto.counters[0]).toMatchObject({ fullName: "Ada", phone: "+1 555 0200" });
  });
});
