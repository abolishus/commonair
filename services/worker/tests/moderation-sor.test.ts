// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The statements-of-reasons planner (ADR 0019 decision 3, docs/testing/w0-selectors.md): one test
 * per row of the decision table, on fixtures copied from each writer's current `details` shape
 * (scan.ts, uploads.ts, routes/moderation.ts, routes/ncii.ts, ncii-clock.ts, t0.ts).
 */
import { DEFAULT_THRESHOLDS, type Thresholds } from "@commonair/moderation";
import { uuidv7 } from "@commonair/db";
import { describe, expect, test } from "vite-plus/test";
import {
  planStatements,
  toRow,
  type AuditRow,
  type CaseFacts,
  type NciiItem,
  type Plan,
  type SorLookup,
  type Statement,
} from "../src/moderation/sor-build.ts";
import { statementMail, statementRef } from "../src/moderation/sor-deliver.ts";

const id = () => uuidv7();
const AT = new Date("2026-10-27T12:00:00Z");
const CAPTURED = new Date("2026-10-27T11:59:50Z");

const owner = id();
const otherOwner = id();
const channelId = id();
const otherChannel = id();
const guidelinesId = id();
const noticeId = id();

interface World {
  cases: Map<string, CaseFacts>;
  reportReasons: Map<string, "harassment">;
  items: NciiItem[];
  itemChannels: Map<string, string>;
  thresholds: Thresholds;
}

function world(): World {
  return {
    cases: new Map(),
    reportReasons: new Map(),
    items: [],
    itemChannels: new Map(),
    thresholds: { ...DEFAULT_THRESHOLDS, t1: { ...DEFAULT_THRESHOLDS.t1, weapons: 0.93 } },
  };
}

function lookup(w: World): SorLookup {
  const owners = new Map([
    [channelId, owner],
    [otherChannel, otherOwner],
  ]);
  return {
    documents: { guidelinesId, noticeId },
    thresholdsAt: async () => w.thresholds,
    moderationCase: async (cid) => w.cases.get(cid) ?? null,
    channelOwner: async (cid) => owners.get(cid) ?? null,
    reportReason: async (cid) => w.reportReasons.get(cid) ?? null,
    flagCapturedAt: async () => CAPTURED,
    nciiRequest: async () => ({
      receivedAt: new Date("2026-10-25T12:00:00Z"),
      deadlineAt: new Date("2026-10-27T12:00:00Z"),
    }),
    nciiItems: async () => w.items,
    itemOwner: async (item) => {
      const c = w.itemChannels.get(item.id);
      const o = c ? owners.get(c) : undefined;
      return c && o ? { channelId: c, ownerId: o } : null;
    },
  };
}

const row = (action: string, details: Record<string, unknown>, ch: string | null = channelId): AuditRow => ({
  id: id(),
  action,
  channelId: ch,
  details,
  createdAt: AT,
});

function statements(p: Plan): Statement[] {
  if (p.kind !== "statements") throw new Error(`expected statements, got ${p.kind} (${p.reason})`);
  return p.statements;
}

/** Nothing a statement may never carry (AGENTS.md, ADR 0019 decision 4). */
function expectNoForbiddenData(s: Statement) {
  const json = JSON.stringify(s);
  for (const k of ["score", "provider", "distance", "pdq", "note", "requester", "email", "evidence", "frame"])
    expect(json.toLowerCase(), k).not.toContain(k);
  expect(s.restriction.territorialScope).toBe("all");
  expect(s.documents).toEqual({ guidelinesId, noticeId });
  expect(s.createdAt).toBe(AT.toISOString());
  // The stored row round-trips through the table's columns.
  expect(toRow(s).createdAt?.toISOString()).toBe(AT.toISOString());
}

const scanDetails = (tier: "t1" | "t2", extra: Record<string, unknown>) => ({
  caseId: id(),
  flagId: id(),
  broadcastId: id(),
  frameId: id(),
  tier,
  score: 0.991,
  provider: "nsfw-onnx",
  providerVersion: "1.2.3",
  ...extra,
});

describe("decision 3, row by row", () => {
  test("moderation.t1.restrict → visibility/restricted, classifier t1 at the threshold in force, moderation_case", async () => {
    const w = world();
    const d = scanDetails("t1", { category: "weapons", restricted: true });
    w.cases.set(d.caseId, {
      origin: "classifier",
      category: "weapons",
      subjectType: "broadcast",
      subjectId: d.broadcastId,
      userId: owner,
      channelId,
    });
    const [s] = statements(await planStatements(row("moderation.t1.restrict", d), lookup(w)));
    expect(s).toMatchObject({
      sourceAction: "moderation.t1.restrict",
      recipientUserId: owner,
      channelId,
      content: { type: "broadcast", id: d.broadcastId },
      restriction: { kind: "visibility", detail: "restricted", endsAt: null },
      facts: {
        code: "classifier",
        category: "weapons",
        tier: "t1",
        threshold: 0.93,
        capturedAt: CAPTURED.toISOString(),
      },
      source: "own_initiative",
      automatedDetection: true,
      automatedDecision: "fully",
      ground: { kind: "terms", clauseId: "safety.weapons", clauseVersion: 1, legalBasis: null },
      appeal: { kind: "moderation", subjectType: "moderation_case", subjectId: d.caseId },
    });
    expectNoForbiddenData(s!);
  });

  test("moderation.t1.flag (case already open) → not allowlisted, no statement", async () => {
    const p = await planStatements(
      row("moderation.t1.flag", scanDetails("t1", { category: "sexual" })),
      lookup(world()),
    );
    expect(p.kind).toBe("none");
  });

  test("moderation.t2.label → visibility/age_gated, classifier t2, content_label appeal", async () => {
    const w = world();
    const labelId = id();
    const d = scanDetails("t2", { category: "sexual", labelId });
    w.cases.set(d.caseId, {
      origin: "classifier",
      category: "sexual",
      subjectType: "broadcast",
      subjectId: d.broadcastId,
      userId: owner,
      channelId,
    });
    const [s] = statements(await planStatements(row("moderation.t2.label", d), lookup(w)));
    expect(s).toMatchObject({
      recipientUserId: owner,
      restriction: { kind: "visibility", detail: "age_gated" },
      facts: { code: "classifier", category: "sexual", tier: "t2", threshold: DEFAULT_THRESHOLDS.t2.sexual },
      automatedDetection: true,
      automatedDecision: "fully",
      ground: { clauseId: "mature.unlabelled" },
      appeal: { subjectType: "content_label", subjectId: labelId },
    });
    expectNoForbiddenData(s!);
  });

  test("moderation.t1.upload_reject → visibility/removed on the upload, to the uploader", async () => {
    const uploader = id();
    const d = {
      caseId: id(),
      flagId: id(),
      subjectType: "upload",
      subjectId: id(),
      userId: uploader,
      purpose: "avatar",
      tier: "t1",
      category: "sexual",
      score: 0.99,
      provider: "nsfw-onnx",
      providerVersion: "1.2.3",
    };
    const [s] = statements(await planStatements(row("moderation.t1.upload_reject", d), lookup(world())));
    expect(s).toMatchObject({
      recipientUserId: uploader,
      content: { type: "upload", id: d.subjectId },
      restriction: { kind: "visibility", detail: "removed" },
      facts: { code: "classifier", tier: "t1", category: "sexual", threshold: 0.97 },
      ground: { clauseId: "safety.sexual-explicit" },
      appeal: { subjectType: "moderation_case", subjectId: d.caseId },
    });
    expectNoForbiddenData(s!);
  });

  const caseRow = (decision: string, extra: Record<string, unknown> = {}) => ({
    caseId: id(),
    decision,
    fromTier: "t1",
    toTier: "t1",
    restrictionLifted: decision === "warn",
    streamEnded: decision !== "warn",
    ...extra,
  });

  test("moderation.case.warn on a classifier case → warning/none, true/not, the case's category", async () => {
    const w = world();
    const d = caseRow("warn");
    const broadcastId = id();
    w.cases.set(d.caseId, {
      origin: "classifier",
      category: "self_harm",
      subjectType: "broadcast",
      subjectId: broadcastId,
      userId: null,
      channelId,
    });
    const [s] = statements(await planStatements(row("moderation.case.warn", d), lookup(w)));
    expect(s).toMatchObject({
      recipientUserId: owner,
      content: { type: "broadcast", id: broadcastId },
      restriction: { kind: "warning", detail: "none", endsAt: null },
      facts: { code: "moderator_review", caseId: d.caseId, caseOrigin: "classifier", decision: "warn" },
      source: "own_initiative",
      automatedDetection: true,
      automatedDecision: "not",
      ground: { clauseId: "safety.self-harm" },
      appeal: { subjectType: "moderation_case", subjectId: d.caseId },
    });
    // The moderator's note (audit `reason`) is never read into the statement.
    expectNoForbiddenData(s!);
  });

  test("moderation.case.end_stream on a report (human) case → visibility/removed, false/not, notice_art16, the report's reason", async () => {
    const w = world();
    const d = caseRow("end_stream");
    w.cases.set(d.caseId, {
      origin: "human",
      category: null,
      subjectType: "broadcast",
      subjectId: id(),
      userId: owner,
      channelId,
    });
    w.reportReasons.set(d.caseId, "harassment");
    const [s] = statements(await planStatements(row("moderation.case.end_stream", d), lookup(w)));
    expect(s).toMatchObject({
      restriction: { kind: "visibility", detail: "removed" },
      facts: { caseOrigin: "human", decision: "end_stream" },
      source: "notice_art16",
      automatedDetection: false,
      automatedDecision: "not",
      ground: { clauseId: "decency.harassment" },
    });
  });

  test("a human case with no report reason cites the general guidelines clause", async () => {
    const w = world();
    const d = caseRow("warn");
    w.cases.set(d.caseId, {
      origin: "human",
      category: null,
      subjectType: "clip",
      subjectId: id(),
      userId: owner,
      channelId,
    });
    const [s] = statements(await planStatements(row("moderation.case.warn", d), lookup(w)));
    expect(s?.ground.clauseId).toBe("guidelines.general");
  });

  test("moderation.case.suspend, user → account/suspended with its end", async () => {
    const w = world();
    const d = caseRow("suspend", { suspendTarget: "user", durationSeconds: 3600 });
    w.cases.set(d.caseId, {
      origin: "classifier",
      category: "sexual",
      subjectType: "broadcast",
      subjectId: id(),
      userId: owner,
      channelId,
    });
    const out = statements(await planStatements(row("moderation.case.suspend", d), lookup(w)));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      recipientUserId: owner,
      content: { type: "account", id: owner },
      restriction: { kind: "account", detail: "suspended", endsAt: new Date(AT.getTime() + 3_600_000).toISOString() },
    });
  });

  test("moderation.case.suspend, channel, indefinite → service/suspended on the channel, to its owner", async () => {
    const w = world();
    const d = caseRow("suspend", { suspendTarget: "channel", durationSeconds: null });
    w.cases.set(d.caseId, {
      origin: "classifier",
      category: "sexual",
      subjectType: "broadcast",
      subjectId: id(),
      userId: owner,
      channelId,
    });
    const out = statements(await planStatements(row("moderation.case.suspend", d), lookup(w)));
    expect(out).toEqual([
      expect.objectContaining({
        recipientUserId: owner,
        content: { type: "channel", id: channelId },
        restriction: expect.objectContaining({ kind: "service", detail: "suspended", endsAt: null }),
      }),
    ]);
  });

  test("moderation.case.suspend, both → one statement per target recipient", async () => {
    const w = world();
    // The case is about a clip someone else made on this channel: two people, two statements.
    const clipper = id();
    const d = caseRow("suspend", { suspendTarget: "both", durationSeconds: 60 });
    w.cases.set(d.caseId, {
      origin: "classifier",
      category: "weapons",
      subjectType: "clip",
      subjectId: id(),
      userId: clipper,
      channelId,
    });
    const out = statements(await planStatements(row("moderation.case.suspend", d), lookup(w)));
    expect(out.map((s) => [s.recipientUserId, s.restriction.kind, s.content.type])).toEqual([
      [clipper, "account", "account"],
      [owner, "service", "channel"],
    ]);
    // Same person for both targets: the account statement covers both (unique per recipient).
    const same = caseRow("suspend", { suspendTarget: "both", durationSeconds: 60 });
    w.cases.set(same.caseId, {
      origin: "classifier",
      category: "weapons",
      subjectType: "broadcast",
      subjectId: id(),
      userId: owner,
      channelId,
    });
    const one = statements(await planStatements(row("moderation.case.suspend", same), lookup(w)));
    expect(one.map((s) => s.restriction.kind)).toEqual(["account"]);
  });

  test("moderation.case.clear and moderation.case.escalate_legal → not allowlisted", async () => {
    for (const a of ["moderation.case.clear", "moderation.case.escalate_legal"])
      expect((await planStatements(row(a, caseRow(a.split(".")[2]!)), lookup(world()))).kind).toBe("none");
  });

  function nciiWorld() {
    const w = world();
    const [b, v, c, u] = [id(), id(), id(), id()];
    w.items = [
      { id: b, subjectType: "broadcast", subjectId: id() },
      { id: v, subjectType: "vod", subjectId: id() },
      { id: c, subjectType: "clip", subjectId: id() },
      { id: u, subjectType: "upload", subjectId: otherChannel },
    ];
    w.itemChannels.set(b, channelId).set(v, channelId).set(c, otherChannel).set(u, otherChannel);
    return { w, first: b, otherFirst: c };
  }

  test("ncii.decide removed → one statement per affected owner, never the requester, ncii_request_item appeal", async () => {
    const { w, first, otherFirst } = nciiWorld();
    const requestId = id();
    const d = { requestId, decision: "removed", items: 4, removedItems: 4 };
    const out = statements(await planStatements(row("ncii.decide", d, null), lookup(w)));
    expect(out).toHaveLength(2);
    expect(out.map((s) => [s.recipientUserId, s.channelId, s.appeal?.subjectId])).toEqual([
      [owner, channelId, first],
      [otherOwner, otherChannel, otherFirst],
    ]);
    for (const s of out) {
      expect(s).toMatchObject({
        restriction: { kind: "visibility", detail: "removed" },
        facts: {
          code: "ncii_notice",
          requestId,
          receivedAt: "2026-10-25T12:00:00.000Z",
          deadlineAt: "2026-10-27T12:00:00.000Z",
        },
        source: "notice_art16",
        automatedDetection: false,
        automatedDecision: "not",
        ground: { kind: "illegal", clauseId: "illegal.ncii", legalBasis: "us.take-it-down" },
        appeal: { kind: "moderation", subjectType: "ncii_request_item" },
      });
      expect(Object.keys(s.facts).toSorted()).toEqual(["code", "deadlineAt", "receivedAt", "requestId"]);
      expectNoForbiddenData(s);
    }
  });

  test("ncii.decide rejected → no statement", async () => {
    const { w } = nciiWorld();
    const p = await planStatements(
      row("ncii.decide", { requestId: id(), decision: "rejected", items: 1, removedItems: 0 }, null),
      lookup(w),
    );
    expect(p).toEqual({ kind: "none", reason: "rejected" });
  });

  test("ncii.auto_hide → visibility/disabled per owner, false/fully", async () => {
    const { w } = nciiWorld();
    const d = {
      requestId: id(),
      items: 4,
      resolvedItems: 4,
      vodIds: [id()],
      clipIds: [id()],
      endedBroadcastIds: [],
      uploadReferencesCleared: 1,
      deadlineAt: "2026-10-27T12:00:00.000Z",
    };
    const out = statements(await planStatements(row("ncii.auto_hide", d, null), lookup(w)));
    expect(out).toHaveLength(2);
    for (const s of out)
      expect(s).toMatchObject({
        restriction: { kind: "visibility", detail: "disabled" },
        automatedDetection: false,
        automatedDecision: "fully",
        appeal: { subjectType: "ncii_request_item" },
      });
  });

  const t0 = (listCategory: "csam" | "ncii") => ({
    caseId: id(),
    flagId: id(),
    holdId: id(),
    userId: owner,
    subjectType: "vod",
    subjectId: id(),
    tier: "t0",
    listCategory,
    distance: 12,
    quality: 90,
    provider: "local",
    providerVersion: "2026-10-01",
    evidenceIds: [id()],
    broadcastEnded: null,
    hiddenVods: [],
    hiddenClips: [],
    ncmecReportId: listCategory === "csam" ? id() : null,
  });

  test("moderation.t0.match, CSAM list → no statement", async () => {
    expect(await planStatements(row("moderation.t0.match", t0("csam")), lookup(world()))).toEqual({
      kind: "none",
      reason: "csam_list",
    });
  });

  test("moderation.t0.match, NCII list → account/suspended indefinitely, hash_match, illegal.ncii, no appeal", async () => {
    const d = t0("ncii");
    const [s] = statements(await planStatements(row("moderation.t0.match", d), lookup(world())));
    expect(s).toMatchObject({
      recipientUserId: owner,
      content: { type: "vod", id: d.subjectId },
      restriction: { kind: "account", detail: "suspended", endsAt: null },
      facts: { code: "hash_match", listCategory: "ncii", capturedAt: CAPTURED.toISOString() },
      source: "own_initiative",
      automatedDetection: true,
      automatedDecision: "fully",
      ground: { kind: "illegal", clauseId: "illegal.ncii" },
      appeal: null,
    });
    expect(Object.keys(s!.facts).toSorted()).toEqual(["capturedAt", "code", "listCategory"]);
    expectNoForbiddenData(s!);
  });

  test("channel moderation (a chat ban or timeout) never produces a statement", async () => {
    // Chat bans and timeouts are `mod_actions` rows with scope `channel`; whatever they audit, it
    // is never an allowlisted action.
    for (const action of ["ban", "timeout", "chat.ban", "chat.timeout", "channel.ban", "mod_action.ban"])
      expect(
        (await planStatements(row(action, { targetUserId: owner, durationSeconds: 600 }), lookup(world()))).kind,
      ).toBe("none");
  });
});

describe("drift and failures", () => {
  test("details that do not parse are invalid (skipped and counted by the job), per action", async () => {
    for (const [action, details] of [
      ["moderation.t1.restrict", { caseId: id(), broadcastId: id(), tier: "t1", category: "weapons" }],
      ["moderation.t2.label", { caseId: id(), flagId: id(), broadcastId: id(), tier: "t2", category: "sexual" }],
      ["moderation.t1.upload_reject", { caseId: "not-a-uuid" }],
      ["moderation.case.suspend", { caseId: id(), decision: "suspend" }],
      ["ncii.decide", { requestId: id(), decision: "maybe" }],
      ["moderation.t0.match", { caseId: id(), listCategory: "ncii" }],
    ] as const)
      expect(await planStatements(row(action, details), lookup(world())), action).toEqual({
        kind: "invalid",
        reason: "details",
      });
  });

  test("a recipient that no longer resolves is invalid, not silently dropped", async () => {
    const d = scanDetails("t1", { category: "weapons" });
    expect(await planStatements(row("moderation.t1.restrict", d, null), lookup(world()))).toEqual({
      kind: "invalid",
      reason: "recipient",
    });
  });
});

describe("the mail of a stored statement", () => {
  test("renders the clause section of the pinned notice, with placeholders, and refs only", async () => {
    const w = world();
    const d = scanDetails("t1", { category: "weapons" });
    w.cases.set(d.caseId, {
      origin: "classifier",
      category: "weapons",
      subjectType: "broadcast",
      subjectId: d.broadcastId,
      userId: owner,
      channelId,
    });
    const [s] = statements(await planStatements(row("moderation.t1.restrict", d), lookup(w)));
    const stored = { ...toRow(s!), territorialScope: "all", restrictionEndsAt: null, legalBasis: null } as Parameters<
      typeof statementMail
    >[0];
    const site = {
      name: "Example Air",
      publicUrl: "https://air.example.test",
      contacts: { abuse: "abuse@air.example.test" },
      sourceUrl: "https://forge.example.test/air",
    } as unknown as Parameters<typeof statementMail>[2];
    const body = [
      "<!-- clause: safety.weapons -->",
      "### Weapons",
      "Not on **{{instanceName}}**.",
      "## Redress",
      "<!-- section: redress -->",
      "Write to {{contacts.abuse}}.",
    ].join("\n");
    const mail = statementMail(stored, { body, isDraft: true }, site);
    expect(mail).toMatchObject({
      statementRef: statementRef(s!.id),
      explanation: "Not on Example Air.",
      redress: "Write to abuse@air.example.test.",
      clauseTitleKey: "clause.safety.weapons",
      clauseRef: "safety.weapons@1",
      appealable: true,
      noticeIsDraft: true,
      appealsUrl: "https://air.example.test/settings/appeals",
      facts: { code: "classifier", threshold: 0.93 },
    });
    expect(mail.statementRef).toMatch(/^SR-[0-9A-F]{8}$/);
  });
});
