// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isDemoFixtureIdentity } from "@commonair/contracts/fixtures";
import { describe, expect, test } from "vite-plus/test";
import { FIXED_ACCOUNTS, bulkStreamerHandle, bulkViewerHandle } from "../../src/seed/accounts.ts";
import { createRng } from "../../src/seed/prng.ts";
import { SEED_SCALES, type SeedScale } from "../../src/seed/scale.ts";
import { unit } from "../../src/seed/safety.ts";
import { retryAfterSeconds } from "../../src/seed/safety/api.ts";
import {
  CELLS,
  CELL_SUSPENSION_SECONDS,
  DMCA_STATES,
  STAFF,
  K,
  NCII_STATES,
  type RecordedBroadcast,
  type SafetyPlan,
  TEXT,
  appealStatuses,
  cellCounts,
  countDelta,
  deciderOf,
  juryInputs,
  mediaInputs,
  ncmecRefusal,
  party,
  planSafety,
  plannedCaseStatuses,
  reportStatuses,
  safetyStoreExtra,
  signInOrder,
} from "../../src/seed/safety/plan.ts";
import { hashMatchRow } from "../../src/seed/safety/write.ts";
import type { SeedStore, SeededUser } from "../../src/seed/types.ts";

const small = SEED_SCALES.small;

/** A store shaped like seed-social's: every fixed login, the bulk accounts, the streamers' channels. */
function store(scale: Pick<SeedScale, "streamers" | "viewers">): Pick<SeedStore, "users" | "channels"> {
  const users: SeededUser[] = [];
  const add = (handle: string, kind: SeededUser["kind"], platformRole = "user") =>
    users.push({
      id: `00000000-0000-7000-8000-${String(users.length).padStart(12, "0")}`,
      handle,
      username: `demo_${handle}`,
      email: `demo_${handle}@demo-seed.invalid`,
      kind,
      platformRole,
    });
  for (const a of FIXED_ACCOUNTS) add(a.handle, a.bot ? "bot" : "fixed", a.platformRole);
  for (let i = 1; i <= scale.streamers; i++) add(bulkStreamerHandle(i), "bulk-streamer");
  for (let i = 1; i <= scale.viewers; i++) add(bulkViewerHandle(i), "bulk-viewer");
  const streamerHandles = new Set([
    ...FIXED_ACCOUNTS.filter((a) => a.streamer).map((a) => a.handle),
    ...users.filter((u) => u.kind === "bulk-streamer").map((u) => u.handle),
  ]);
  const channels = users
    .filter((u) => streamerHandles.has(u.handle))
    .map((u, i) => ({
      id: `00000000-0000-7000-9000-${String(i).padStart(12, "0")}`,
      ownerId: u.id,
      ownerHandle: u.handle,
      slug: u.username,
    }));
  return { users, channels };
}

const recorded = (s: Pick<SeedStore, "channels">): RecordedBroadcast[] =>
  s.channels.slice(0, 4).map((c, i) => ({ channelId: c.id, broadcastId: `b-${i}` }));

const plan = (seed = 7, scale: SeedScale = small, vodIds: string[] = ["vod-1"]): SafetyPlan => {
  const s = store(scale);
  return planSafety(createRng(seed).fork("safety"), scale, { store: s, recorded: recorded(s), vodIds });
};

/** The plan's shape without its content: what must not change with the seed. */
const counts = (p: SafetyPlan) => ({
  live: p.live.map((l) => [l.role, l.clips, l.sexualScore]),
  t0: p.t0.length,
  ncii: p.ncii.map((x) => x.state),
  dmca: p.dmca.map((x) => x.state),
  reports: p.reports.length,
  outcomes: p.reports.map((r) => r.outcome.status),
  appeals: p.appeals.map((a) => a.outcome),
  cells: cellCounts(p),
});

describe("planSafety: determinism", () => {
  test("the same seed and scale give the same plan", () => {
    expect(plan(7)).toEqual(plan(7));
  });

  test("a different seed changes the content but not the counts", () => {
    const a = plan(7);
    const b = plan(8);
    expect(counts(a)).toEqual(counts(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  test("pattern seeds are unique per live channel (an NCII hash never matches another stream)", () => {
    const seeds = plan().live.map((l) => l.patternSeed);
    expect(new Set(seeds).size).toBe(seeds.length);
  });
});

describe("planSafety: scale", () => {
  test("counts scale with the factor", () => {
    const s = plan(7, small);
    const m = plan(7, SEED_SCALES.medium);
    expect(m.reports.length).toBeGreaterThan(s.reports.length * 5);
    expect(cellCounts(s)).toEqual([K, K]);
    expect(cellCounts(m)).toEqual([K * 10, K * 10]);
  });

  test("the largest preset's counts are computed without writing", () => {
    const l = plan(7, SEED_SCALES.large);
    expect(cellCounts(l)).toEqual([K * 100, K * 100]);
    expect(l.reports.length).toBeGreaterThan(2 * K * 100);
    expect(l.live).toHaveLength(9);
  });

  test("zero bulk accounts: no live bulk roles, no cells, and notes say so", () => {
    const p = plan(7, { ...small, streamers: 0, viewers: 0 });
    expect(p.live.map((l) => l.role)).toEqual(["viewer2", "banned"]);
    expect(cellCounts(p)).toEqual([0, 0]);
    expect(p.t0).toEqual([]);
    expect(p.deletion).toBeNull();
    expect(p.ncii).toEqual([]);
    expect(p.notes.join("\n")).toMatch(/too few bulk streamers/);
    expect(p.notes.join("\n")).toMatch(/too few bulk viewers/);
    // Reports still have a reporter (viewer1 stands in).
    expect(p.reports.every((r) => r.reporter.length > 0)).toBe(true);
  });

  test("a missing fixed login is refused", () => {
    const s = store(small);
    const users = s.users.filter((u) => u.handle !== "legal");
    expect(() =>
      planSafety(createRng(1), small, { store: { users, channels: s.channels }, recorded: [], vodIds: [] }),
    ).toThrow(/legal/);
  });
});

describe("planSafety: every state appears at small", () => {
  const p = plan();

  test("moderation cases", () => {
    expect(plannedCaseStatuses(p)).toEqual([
      "actioned",
      "cleared",
      "confirmed",
      "dismissal_pending",
      "labelled",
      "open",
    ]);
  });

  test("reports and appeals", () => {
    expect(reportStatuses(p)).toEqual(["actioned", "dismissed", "open"]);
    expect(appealStatuses(p)).toEqual(["open", "overturned", "upheld"]);
  });

  test("DMCA notices and NCII requests", () => {
    expect(new Set(p.dmca.map((d) => d.state))).toEqual(new Set(DMCA_STATES));
    expect(p.ncii.map((x) => x.state).sort()).toEqual([...NCII_STATES].sort());
    // Every NCII request has its own clip, and the clips exist on the ncii aux role.
    const aux = p.live.find((l) => l.role === "nciiAux");
    expect(p.ncii.map((x) => x.clip.index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(aux?.clips).toBe(4);
  });

  test("every referenced clip is cut by its role", () => {
    const refs = [
      ...p.ncii.map((x) => x.clip),
      ...p.dmca.flatMap((d) => (d.target.kind === "clip" ? [d.target.clip] : [])),
      ...p.reports.flatMap((r) => (r.subject.kind === "clip" ? [r.subject.clip] : [])),
    ];
    for (const ref of refs) {
      const l = p.live.find((x) => x.role === ref.role);
      expect(l, ref.role).toBeDefined();
      expect(ref.index).toBeLessThan(l?.clips ?? 0);
    }
  });

  test("a channel ban is planned, and it cites no clause", () => {
    const bans = p.reports.filter((r) => r.outcome.status === "actioned" && r.outcome.action === "ban_from_channel");
    expect(bans).toHaveLength(1);
    expect(bans[0]?.outcome).toMatchObject({ clauseId: null });
  });

  test("incidents: one resolved, one ongoing", () => {
    expect(p.incidents.map((i) => i.statuses.at(-1))).toEqual(["resolved", "monitoring"]);
  });

  test("incidents name only components the status page reports on", () => {
    // statusComponentIds in services/api: postgres, valkey and the probes in statusProbes.
    const known = ["postgres", "valkey", "mediamtx", "chat", "origin"];
    for (const i of p.incidents) for (const c of i.components) expect(known, i.title).toContain(c);
  });
});

describe("planSafety: enforcement cells (/transparency)", () => {
  test("at least two cells reach k at small, each a suspension citing its own clause", () => {
    const p = plan();
    const reached = cellCounts(p).filter((n) => n >= K);
    expect(reached.length).toBeGreaterThanOrEqual(2);
    for (const [i, c] of CELLS.entries()) {
      const rows = p.reports.filter((r) => r.cell === i);
      expect(new Set(rows.map((r) => (r.subject.kind === "user" ? r.subject.handle : "")))).toHaveProperty(
        "size",
        rows.length,
      );
      for (const r of rows)
        expect(r.outcome).toEqual({
          status: "actioned",
          action: "suspend_user",
          clauseId: c.clauseId,
          durationSeconds: CELL_SUSPENSION_SECONDS,
        });
    }
  });

  test("cell targets are bulk viewers, never fixed logins", () => {
    const p = plan();
    for (const r of p.reports.filter((x) => x.cell !== null))
      expect(r.subject.kind === "user" && r.subject.handle.startsWith("v")).toBe(true);
  });

  test("at least one appeal is overturned, and one cell suspension's appeal among them", () => {
    const p = plan();
    expect(p.appeals.filter((a) => a.outcome === "overturned").length).toBeGreaterThanOrEqual(2);
    const cellKeys = new Set(p.reports.filter((r) => r.cell !== null).map((r) => r.key));
    expect(
      p.appeals.some(
        (a) => a.outcome === "overturned" && a.subject.kind === "reportAction" && cellKeys.has(a.subject.reportKey),
      ),
    ).toBe(true);
  });
});

describe("planSafety: fixed logins", () => {
  const p = plan();

  test("viewer2: one report filed, a lesser action, a countered notice, one appeal decided and one pending", () => {
    expect(p.reports.filter((r) => r.reporter === "viewer2")).toHaveLength(1);
    const removal = p.reports.find((r) => r.subject.kind === "chatBy" && r.subject.authorHandle === "viewer2");
    expect(removal?.outcome).toMatchObject({ status: "actioned", action: "remove_content" });
    expect(p.dmca.find((d) => d.key === "viewer2")).toMatchObject({
      state: "countered",
      counter: { handle: "viewer2" },
    });
    const mine = p.appeals.filter((a) => a.appellant === "viewer2").map((a) => a.outcome);
    expect(mine.sort()).toEqual(["open", "upheld"]);
  });

  test("banned: suspended by admin, three strikes to termination, a pending appeal, a legal hold", () => {
    expect(p.adminSuspension?.handle).toBe("banned");
    expect(p.dmca.filter((d) => d.key.startsWith("banned") && d.state === "actioned")).toHaveLength(3);
    expect(p.appeals.filter((a) => a.appellant === "banned")).toEqual([
      { key: "banned", appellant: "banned", subject: { kind: "termination" }, outcome: "open" },
    ]);
    expect(p.legalHold?.handle).toBe("banned");
    expect(p.restricted).toContain("banned");
  });

  test("viewer1 exports its data; a bulk viewer (never a fixed login) schedules deletion", () => {
    expect(p.dataExport).toBe("viewer1");
    expect(p.deletion).toMatch(/^v\d{5}$/);
    expect(p.restricted).toContain(p.deletion);
  });

  test("mod has pending appeals from bulk users", () => {
    const pending = p.appeals.filter((a) => a.outcome === "open" && /^v\d{5}$/.test(a.appellant));
    expect(pending.length).toBeGreaterThanOrEqual(1);
  });

  test("legal: one T0 case confirmed (CSAM list), one first dismissal (NCII list)", () => {
    expect(p.t0.map((t) => [t.fixture, t.decision])).toEqual([
      ["csam", "confirm"],
      ["ncii", "first_dismissal"],
    ]);
  });

  test("everyone suspended or acting is signed in, the suspended ones before anything happens", () => {
    const order = signInOrder(p);
    for (const a of p.appeals) expect(order).toContain(a.appellant);
    for (const l of p.live) expect(order).toContain(l.handle);
    for (const r of p.reports) expect(order).toContain(r.reporter);
    expect(order).toContain("streamer1");
    expect(new Set(order).size).toBe(order.length);
  });
});

describe("planSafety: attestations and media inputs", () => {
  test("attestations are planned for every recorded broadcast", () => {
    const s = store(small);
    const rec = recorded(s);
    const p = planSafety(createRng(3), small, { store: s, recorded: rec, vodIds: [] });
    expect(p.attestations).toEqual(rec);
    const s1 = s.channels.find((c) => c.ownerHandle === "streamer1");
    expect(p.groupAppealCandidates.every((b) => b.channelId === s1?.id)).toBe(true);
  });

  test("no recordings: nothing attested, and a note says so", () => {
    const p = plan();
    const empty = planSafety(createRng(7).fork("safety"), small, { store: store(small), recorded: [], vodIds: [] });
    expect(p.attestations.length).toBeGreaterThan(0);
    expect(empty.attestations).toEqual([]);
    expect(empty.notes.join("\n")).toMatch(/recordedBroadcasts/);
    expect(empty.dmca.some((d) => d.target.kind === "vod")).toBe(false);
  });

  test("mediaInputs reads seed-media's keys and skips streamer1's VODs", () => {
    expect(mediaInputs(undefined, null)).toEqual({ recorded: [], vodIds: [] });
    expect(mediaInputs({ recordedBroadcasts: "x", vodsByChannel: [] }, null)).toEqual({ recorded: [], vodIds: [] });
    expect(
      mediaInputs(
        {
          recordedBroadcasts: [{ channelId: "c1", broadcastId: "b1" }, { channelId: 3 }],
          vodsByChannel: { s1: ["v-s1"], c2: ["v2", 4], c1: ["v1"] },
        },
        "s1",
      ),
    ).toEqual({ recorded: [{ channelId: "c1", broadcastId: "b1" }], vodIds: ["v1", "v2"] });
  });
});

describe("jury inputs (seed-coop)", () => {
  test("closed T1/T2 cases and resolved reports only; never T0 or NCII", () => {
    const out = juryInputs(
      [
        { id: "t1-cleared", tier: "t1", status: "cleared", listCategory: null },
        { id: "t2-actioned", tier: "t2", status: "actioned", listCategory: null },
        { id: "t1-open", tier: "t1", status: "open", listCategory: null },
        { id: "t0-confirmed", tier: "t0", status: "confirmed", listCategory: "csam" },
        { id: "t0-ncii", tier: "t0", status: "dismissed", listCategory: "ncii" },
        { id: "t2-labelled", tier: "t2", status: "labelled", listCategory: null },
      ],
      [
        { id: "r-actioned", status: "actioned", reason: "spam" },
        { id: "r-dismissed", status: "dismissed", reason: "hate" },
        { id: "r-open", status: "open", reason: "spam" },
        { id: "r-ncii", status: "actioned", reason: "ncii" },
      ],
    );
    expect(out).toEqual({ juryCaseIds: ["t1-cleared", "t2-actioned"], juryReportIds: ["r-actioned", "r-dismissed"] });
  });

  test("the plan resolves enough reports for the jury's ten at small", () => {
    const resolved = plan().reports.filter((r) => r.outcome.status !== "open" && r.reason !== ("ncii" as string));
    expect(resolved.length).toBeGreaterThanOrEqual(10);
  });
});

describe("refusals and hygiene", () => {
  test("a configured NCMEC reporter is refused; the FOSS default (nothing set) runs", () => {
    expect(ncmecRefusal({})).toBeNull();
    expect(ncmecRefusal({ NCMEC_REPORTER: "", PATH: "/bin" })).toBeNull();
    expect(ncmecRefusal({ NCMEC_REPORTER: "cybertipline" })).toMatch(/NCMEC_REPORTER/);
    expect(ncmecRefusal({ CYBERTIPLINE_API_KEY: "k" })).toMatch(/CYBERTIPLINE_API_KEY/);
  });

  test("synthetic parties use the demo anchors", () => {
    for (const k of ["claimant", "requester", "uploader"] as const) {
      const p = party(k, 3);
      expect(p.email).toMatch(/^demo_[a-z]+3@demo-seed\.invalid$/);
      expect(isDemoFixtureIdentity(`demo_${k}3`, p.email)).toBe(true);
    }
    for (const d of plan().dmca) expect(d.claimant.email.endsWith("@demo-seed.invalid")).toBe(true);
  });

  test("every note, resolution and appeal body is fixed template text with no contact data", () => {
    for (const v of Object.values(TEXT)) {
      expect(v).not.toMatch(/@|https?:\/\//);
      expect(v.length).toBeGreaterThanOrEqual(10);
    }
  });

  test("hash match rows carry ids and enums only", () => {
    const row = hashMatchRow({
      subjectType: "upload",
      subjectId: "00000000-0000-7000-8000-000000000001",
      provider: "fixture-list",
      matched: true,
      caseId: "00000000-0000-7000-8000-000000000002",
      listCategory: "csam",
      distance: 0,
      checkedAt: new Date("2026-11-01T00:00:00Z"),
    });
    expect(Object.keys(row.details).sort()).toEqual(["caseId", "distance", "listCategory"]);
  });

  test("a 429's retry-after is read from the body, else a default", () => {
    expect(retryAfterSeconds('sign-in failed: HTTP 429 {"code":"RATE_LIMITED","data":{"retryAfterSeconds":17}}')).toBe(
      17,
    );
    expect(retryAfterSeconds("sign-in failed: HTTP 429")).toBe(6);
  });
});

describe("the unit", () => {
  test("nothing stays pending: the evidence audit table is seeded through the ops tick", () => {
    expect(unit.pending).toEqual([]);
    expect(unit.tables).toContain("evidence_audit_runs");
    expect(unit.after).toEqual(["social", "media"]);
  });
});

describe("review fixes", () => {
  test("no appeal is resolved by the staff member who decided its subject (appeals.resolve refuses it)", () => {
    for (const scale of [small, SEED_SCALES.medium]) {
      const resolved = plan(7, scale).appeals.filter((a) => a.outcome !== "open");
      expect(resolved.length).toBeGreaterThan(0);
      for (const a of resolved) expect(deciderOf(a.subject)).not.toBe(STAFF.appeals);
    }
    expect(STAFF.appeals).toBe("admin");
  });

  test("rows are the change across the run, so rows earlier units wrote are not counted", () => {
    expect(countDelta({ mod_actions: 12, reports: 0 }, { mod_actions: 40, reports: 9, appeals: 3 })).toEqual({
      mod_actions: 28,
      reports: 9,
      appeals: 3,
    });
  });

  test("the plan notes the future stamps the test-hook clocks leave", () => {
    const notes = plan().notes.join("\n");
    expect(notes).toMatch(/12 weekdays ahead.*\/admin\/dmca.*\/settings\/copyright/);
    expect(notes).toMatch(/48 h ahead.*\/admin\/moderation/);
  });

  test("store.extra.safety carries the jury keys and the restricted ids seed-platform avoids", () => {
    const extra = safetyStoreExtra({
      juryCaseIds: ["c"],
      juryReportIds: ["r"],
      restrictedUserIds: ["x"],
      extraKey: 1,
    } as Parameters<typeof safetyStoreExtra>[0]);
    expect(extra).toEqual({ juryCaseIds: ["c"], juryReportIds: ["r"], restrictedUserIds: ["x"] });
  });
});
