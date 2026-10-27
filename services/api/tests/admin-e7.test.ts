// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** E7-admin pure logic: egress range and sums, incident rules, the integrity details allow-list. */
import { describe, expect, test } from "vite-plus/test";
import {
  EGRESS_MAX_RANGE_MS,
  egressRange,
  fillSources,
  groupByBroadcast,
  safeBytes,
  zeroBytes,
} from "../src/admin/egress.ts";
import { checkComponents, incidentAction, nextResolvedAt, statusComponentIds } from "../src/admin/incidents.ts";
import { DETAIL_KEYS, safeString, sanitizeDetails, toFlag } from "../src/admin/integrity.ts";

const at = (s: string) => new Date(s).toISOString();

describe("egress range", () => {
  test("accepts from < to up to 31 days", () => {
    const from = "2026-10-01T00:00:00.000Z";
    const r = egressRange(from, new Date(Date.parse(from) + EGRESS_MAX_RANGE_MS).toISOString());
    expect(r.to.getTime() - r.from.getTime()).toBe(EGRESS_MAX_RANGE_MS);
    expect(egressRange("2026-10-01T00:00:00Z", "2026-10-01T00:00:01Z").from.toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });
  test("accepts offsets other than Z", () => {
    const r = egressRange("2026-10-01T02:00:00+02:00", "2026-10-01T01:00:00Z");
    expect(r.from.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
  test.each([
    ["equal bounds", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"],
    ["reversed", "2026-10-02T00:00:00Z", "2026-10-01T00:00:00Z"],
    ["one ms over 31 days", "2026-10-01T00:00:00.000Z", at("2026-11-01T00:00:00.001Z")],
    ["not a date", "nope", "2026-10-01T00:00:00Z"],
  ])("rejects %s", (_name, from, to) => {
    expect(() => egressRange(from, to)).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
  });
});

describe("egress sums", () => {
  test("every source is present, 0 when none", () => {
    expect(zeroBytes()).toEqual({ origin: 0, relay: 0, p2p: 0, cdn: 0 });
    expect(fillSources([])).toEqual({ origin: 0, relay: 0, p2p: 0, cdn: 0 });
    expect(fillSources([{ source: "p2p", bytes: "42" }])).toEqual({ origin: 0, relay: 0, p2p: 42, cdn: 0 });
  });
  test("adds repeated sources and ignores unknown ones", () => {
    expect(
      fillSources([
        { source: "origin", bytes: "10" },
        { source: "origin", bytes: 5 },
        { source: "satellite", bytes: "99" },
      ]),
    ).toEqual({ origin: 15, relay: 0, p2p: 0, cdn: 0 });
  });
  test("refuses unsafe or negative sums", () => {
    expect(safeBytes(null)).toBe(0);
    expect(safeBytes("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => safeBytes("9007199254740993")).toThrow("not a safe");
    expect(() => safeBytes("-1")).toThrow("not a safe");
    expect(() => safeBytes("1.5")).toThrow("not a safe");
    expect(() =>
      fillSources([
        { source: "cdn", bytes: Number.MAX_SAFE_INTEGER },
        { source: "cdn", bytes: 1 },
      ]),
    ).toThrow("not a safe");
  });
  test("groups per-broadcast rows in order with zero-filled sources", () => {
    const rows = [
      { broadcast_id: "b2", slug: "two", source: "origin", bytes: "300" },
      { broadcast_id: "b2", slug: "two", source: "relay", bytes: "100" },
      { broadcast_id: "b1", slug: "one", source: "cdn", bytes: "50" },
    ];
    expect(groupByBroadcast(rows)).toEqual([
      { broadcastId: "b2", channelSlug: "two", bytes: { origin: 300, relay: 100, p2p: 0, cdn: 0 } },
      { broadcastId: "b1", channelSlug: "one", bytes: { origin: 0, relay: 0, p2p: 0, cdn: 50 } },
    ]);
    expect(groupByBroadcast([])).toEqual([]);
  });
});

describe("incidents", () => {
  test("components are the status probes", () => {
    expect(statusComponentIds({})).toEqual(["postgres", "valkey"]);
    expect(statusComponentIds({ chat: 1, origin: 1, postgres: 1 })).toEqual(["postgres", "valkey", "chat", "origin"]);
  });
  test("checkComponents trims, de-duplicates and refuses unknown ids", () => {
    const known = ["postgres", "valkey", "chat"];
    expect(checkComponents([" postgres", "postgres", "chat", ""], known)).toEqual(["postgres", "chat"]);
    expect(checkComponents([], known)).toEqual([]);
    expect(() => checkComponents(["db"], known)).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
  });
  test("resolved_at is set once and cleared on reopen", () => {
    const now = new Date("2026-10-27T10:00:00Z");
    const earlier = new Date("2026-10-27T09:00:00Z");
    expect(nextResolvedAt("resolved", null, now)).toBe(now);
    expect(nextResolvedAt("resolved", earlier, now)).toBe(earlier);
    expect(nextResolvedAt("monitoring", earlier, now)).toBeNull();
    expect(nextResolvedAt("investigating", null, now)).toBeNull();
  });
  test("audit actions", () => {
    expect(incidentAction(true, null, "investigating")).toBe("incident.open");
    expect(incidentAction(true, null, "resolved")).toBe("incident.open");
    expect(incidentAction(false, "investigating", "identified")).toBe("incident.update");
    expect(incidentAction(false, "monitoring", "resolved")).toBe("incident.resolve");
    expect(incidentAction(false, "resolved", "resolved")).toBe("incident.update");
    expect(incidentAction(false, "resolved", "investigating")).toBe("incident.update");
  });
});

describe("integrity details allow-list", () => {
  test("keeps what the signals write", () => {
    const details = {
      network: "hosting:example",
      asn: 64500,
      checks: ["periodic_timing"],
      beats: 12,
      intervalStdevMs: 3,
      sessionScore: 0.91,
      threshold: 0.8,
      bursts: [{ minuteStart: "2026-10-27T10:00:00.000Z", follows: 30, excluded: 12 }],
      since: null,
    };
    expect(sanitizeDetails(details)).toEqual(details);
  });
  test("drops personal data keys and address-like strings", () => {
    expect(
      sanitizeDetails({
        ip: "203.0.113.9",
        ipHash: "abc",
        userAgent: "Mozilla/5.0",
        fingerprint: { userAgent: "x" },
        deviceHash: "d",
        email: "a@example.com",
        network: "198.51.100.0/24",
        reason: "2001:db8::1",
        checks: ["ok", "203.0.113.9:443"],
        bursts: [{ minuteStart: "2026-10-27T10:00:00.000Z", ip: "203.0.113.9" }],
        asn: 64500,
      }),
    ).toEqual({ checks: ["ok"], bursts: [{ minuteStart: "2026-10-27T10:00:00.000Z" }], asn: 64500 });
  });
  test("drops long strings and deep nesting", () => {
    expect(sanitizeDetails({ reason: "x".repeat(201) })).toEqual({});
    expect(sanitizeDetails({ bursts: [[[["deep"]]]] })).toEqual({ bursts: [[[]]] });
  });
  test("safeString lets timestamps and codes through", () => {
    expect(safeString("2026-10-27T10:00:00.000Z")).toBe(true);
    expect(safeString("hosting:example")).toBe(true);
    expect(safeString("10.0.0.1")).toBe(false);
    expect(safeString("::1")).toBe(false);
    expect(safeString("[2001:db8::1]")).toBe(false);
  });
  test("never allows obvious personal keys", () => {
    for (const k of ["ip", "ipHash", "userAgent", "fingerprint", "deviceHash", "email", "userId"])
      expect(DETAIL_KEYS.has(k)).toBe(false);
  });
  test("toFlag maps a row", () => {
    const createdAt = new Date("2026-10-27T10:00:00Z");
    expect(
      toFlag({
        id: "f",
        subjectType: "session",
        subjectId: "s",
        channelId: null,
        signal: "datacenter_ip",
        score: 0.6,
        details: { network: "hosting:x", userAgent: "UA" },
        decision: "pending_review",
        decidedById: null,
        decidedAt: null,
        createdAt,
      }),
    ).toEqual({
      id: "f",
      subjectType: "session",
      subjectId: "s",
      signal: "datacenter_ip",
      score: 0.6,
      details: { network: "hosting:x" },
      decision: "pending_review",
      createdAt: "2026-10-27T10:00:00.000Z",
    });
  });
});
