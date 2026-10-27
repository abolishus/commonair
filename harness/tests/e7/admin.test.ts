// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `e7-admin`: the pure helpers and the scenario's registration. */
import { describe, expect, test } from "vite-plus/test";
import { bytesAttr, egressRange, incidentOnStatus, newId, notOperational, utcInput } from "../../src/e7/admin.ts";
import { validateScenario } from "../../src/registry.ts";

describe("e7-admin helpers", () => {
  test("utcInput is UTC to the minute", () => {
    expect(utcInput(new Date("2026-10-27T12:34:56.789Z"))).toBe("2026-10-27T12:34");
  });

  test("egressRange covers the broadcast's minutes and ends after now", () => {
    const r = egressRange(new Date("2026-10-27T12:00:40Z"), new Date("2026-10-27T12:03:10Z"));
    expect(r.from.toISOString()).toBe("2026-10-27T11:55:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-27T12:05:00.000Z");
    expect(r).toMatchObject({ fromInput: "2026-10-27T11:55", toInput: "2026-10-27T12:05" });
    // On a minute boundary the current minute's bucket is still inside [from, to).
    const exact = egressRange(new Date("2026-10-27T12:00:00Z"), new Date("2026-10-27T12:01:00Z"), 0);
    expect(exact.from.toISOString()).toBe("2026-10-27T12:00:00.000Z");
    expect(exact.to.toISOString()).toBe("2026-10-27T12:02:00.000Z");
  });

  test("bytesAttr reads non-negative integers only", () => {
    expect(bytesAttr("0")).toBe(0);
    expect(bytesAttr("1500000")).toBe(1_500_000);
    expect(bytesAttr(null)).toBeNull();
    expect(bytesAttr(undefined)).toBeNull();
    expect(bytesAttr("")).toBeNull();
    expect(bytesAttr("-1")).toBeNull();
    expect(bytesAttr("1.5")).toBeNull();
    expect(bytesAttr("99999999999999999999")).toBeNull();
  });

  test("newId finds the created row", () => {
    expect(newId(["a", "b"], ["c", "a", "b"])).toBe("c");
    expect(newId(["a"], ["a"])).toBeNull();
    expect(newId([], [])).toBeNull();
  });

  test("incidentOnStatus and notOperational", () => {
    const status = {
      components: [
        { id: "postgres", status: "degraded" },
        { id: "valkey", status: "operational" },
      ],
      incidents: [
        { id: "i1", status: "investigating", components: ["postgres"], resolvedAt: null },
        { id: "i2", status: "resolved", components: [], resolvedAt: "2026-10-27T12:00:00.000Z" },
      ],
    };
    expect(incidentOnStatus(status, "i1", "postgres")).toEqual({
      listed: true,
      incidentStatus: "investigating",
      resolved: false,
      component: "degraded",
    });
    expect(incidentOnStatus(status, "i2", "valkey")).toMatchObject({ resolved: true, component: "operational" });
    expect(incidentOnStatus(status, "nope", "chat")).toEqual({
      listed: false,
      incidentStatus: null,
      resolved: false,
      component: null,
    });
    expect(notOperational("degraded")).toBe(true);
    expect(notOperational("outage")).toBe(true);
    expect(notOperational("operational")).toBe(false);
    expect(notOperational(null)).toBe(false);
  });
});

describe("the e7-admin scenario", () => {
  test("is a valid scenario named after its file, in full, with the stack it drives", async () => {
    const mod = (await import("../../scenarios/e7-admin.ts")) as { default: unknown };
    const s = validateScenario(mod.default, "e7-admin.ts");
    expect(s.name).toBe("e7-admin");
    expect(s.inFull).not.toBe(false);
    for (const need of ["api", "web", "media", "worker", "browser"]) expect(s.needs).toContain(need);
    expect(s.timeoutMs ?? 0).toBeGreaterThan(0);
  });
});
