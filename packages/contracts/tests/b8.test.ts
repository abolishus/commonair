// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Batch 8 contract step (M1 money seams, B8 fields): enums, events, entities, procedures, jobs. */
import type { z } from "zod";
import { describe, expect, test } from "vite-plus/test";
import {
  EnforcementFacts,
  GiveawayVerification,
  ImportChoices,
  PatronagePayoutView,
  PayoutTransferView,
  RefundRequestView,
} from "../src/api/entities.ts";
import { contract } from "../src/api/router.ts";
import { ClientFrame } from "../src/chat.ts";
import {
  ENFORCEMENT_FACT_CODES,
  ENFORCEMENT_SOURCE_ACTIONS,
  PATRONAGE_PAYOUT_STATUSES,
  PAYOUT_TRANSFER_STATUSES,
  REFUND_MARKER_ACTIONS,
  STAFF_ACTION_SOURCE_ACTIONS,
} from "../src/enums.ts";
import { EVENTS, PUBLIC_EVENT_TYPES, isInternalEvent } from "../src/events.ts";
import {
  B8_JOBS,
  PatronagePayoutJob,
  PayoutTransferJob,
  RoomSyncReport,
  patronagePayoutJobId,
  payoutTransferJobId,
} from "../src/internal.ts";
import { SharesCardPaymentsSetting } from "../src/shapes.ts";

const id = (n: number) => `01890000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const at = "2026-11-03T12:00:00.000Z";
const outputOf = (p: { "~orpc": { outputSchema?: unknown } }) => p["~orpc"].outputSchema as z.ZodType;
const inputOf = (p: { "~orpc": { inputSchema?: unknown } }) => p["~orpc"].inputSchema as z.ZodType;

describe("enums", () => {
  test("statuses and markers", () => {
    expect(PAYOUT_TRANSFER_STATUSES).toEqual(["pending", "created", "failed", "reversed"]);
    expect(PATRONAGE_PAYOUT_STATUSES).toEqual(["pending", "paid", "failed", "reversed"]);
    expect(REFUND_MARKER_ACTIONS).toContain("payment.refund_outcome_unknown");
    expect(ENFORCEMENT_FACT_CODES).toContain("staff_action");
    for (const a of STAFF_ACTION_SOURCE_ACTIONS) expect(ENFORCEMENT_SOURCE_ACTIONS).toContain(a);
  });

  test("shares.cardPayments", () => {
    expect(SharesCardPaymentsSetting.parse({ enabled: false })).toEqual({ enabled: false });
    expect(SharesCardPaymentsSetting.safeParse({ enabled: "yes" }).success).toBe(false);
  });
});

describe("events", () => {
  const internal = [
    "federation.actor.disabled",
    "channel.federation",
    "money.payout_transfer.created",
    "money.payout_transfer.failed",
    "money.payout_transfer.reversed",
    "coop.patronage_payout.paid",
    "coop.patronage_payout.reversed",
  ] as const;

  test("the batch 8 events are internal, never offered to apps", () => {
    for (const t of internal) {
      expect(isInternalEvent(t)).toBe(true);
      expect(PUBLIC_EVENT_TYPES).not.toContain(t);
    }
    const subscribe = contract.developer.events.subscribe["~orpc"].inputSchema as z.ZodObject;
    expect(subscribe.shape.type.safeParse("money.payout_transfer.created").success).toBe(false);
  });

  test("payloads", () => {
    expect(EVENTS["federation.actor.disabled"].payload.parse({ channel_id: id(1) })).toEqual({ channel_id: id(1) });
    expect(EVENTS["channel.federation"].payload.safeParse({ channel_id: id(1), enabled: false }).success).toBe(true);
    expect(EVENTS["channel.federation"].payload.safeParse({ channel_id: id(1) }).success).toBe(false);
    expect(
      EVENTS["money.payout_transfer.reversed"].payload.safeParse({
        transfer_id: id(1),
        payout_id: id(2),
        payee_user_id: id(3),
        amount_cents: 500,
        reversed_cents: 1500,
        currency: "usd",
      }).success,
    ).toBe(true);
    expect(
      EVENTS["coop.patronage_payout.paid"].payload.safeParse({
        patronage_payout_id: id(1),
        period_id: id(2),
        user_id: id(3),
        amount_cents: 700,
        currency: "usd",
        provider: "manual",
      }).success,
    ).toBe(true);
  });
});

describe("entities", () => {
  test("refund requests, transfers and patronage payouts", () => {
    const money = { cents: 499, currency: "usd" };
    expect(
      RefundRequestView.safeParse({
        id: id(1),
        paymentId: id(2),
        paymentKind: "subscription",
        provider: "stripe",
        amount: money,
        requested: money,
        state: "unknown",
        reason: null,
        requestedBy: null,
        markers: [
          { action: "payment.refund_requested", at },
          { action: "payment.refund_outcome_unknown", at },
        ],
        createdAt: at,
      }).success,
    ).toBe(true);
    const user = { id: id(3), username: "ada", displayName: "Ada" };
    expect(
      PayoutTransferView.safeParse({
        id: id(1),
        payoutId: id(2),
        user,
        periodStart: at,
        amount: money,
        reversed: { cents: 0, currency: "usd" },
        status: "failed",
        failureCode: "account_not_ready",
        providerRef: null,
        createdAt: at,
        updatedAt: at,
      }).success,
    ).toBe(true);
    expect(
      PatronagePayoutView.safeParse({
        id: id(1),
        periodId: id(2),
        user,
        amount: money,
        provider: "manual",
        status: "paid",
        reference: "BANK-1",
        createdAt: at,
        paidAt: at,
      }).success,
    ).toBe(true);
  });

  test("staff-action statement facts cite no case", () => {
    const facts = { code: "staff_action", action: "user.suspend", clauseId: "conduct.harassment", appliedAt: at };
    expect(EnforcementFacts.parse(facts)).toEqual(facts);
    expect(EnforcementFacts.safeParse({ ...facts, action: "moderation.case.warn" }).success).toBe(false);
    const parsed = EnforcementFacts.parse({ ...facts, caseId: id(9) });
    expect(parsed).not.toHaveProperty("caseId");
  });

  test("import field choices: absent means every field", () => {
    const base = { channel: true, panels: false, emotes: [] };
    expect(ImportChoices.parse(base).fields).toBeUndefined();
    expect(ImportChoices.parse({ ...base, fields: { title: true, tags: false } }).fields).toEqual({
      title: true,
      tags: false,
    });
    expect(ImportChoices.safeParse({ ...base, fields: { title: "yes" } }).success).toBe(false);
  });

  test("giveaway verification carries the caller's own entry, or null", () => {
    const v = {
      id: id(1),
      channelSlug: "ada",
      title: "t",
      status: "drawn",
      seedCommitment: "c",
      seed: null,
      entries: [],
      winnerCount: 1,
      winners: [],
      drawnAt: null,
    };
    expect(GiveawayVerification.safeParse({ ...v, me: null }).success).toBe(true);
    expect(GiveawayVerification.safeParse({ ...v, me: { pseudonym: "p" } }).success).toBe(true);
    expect(GiveawayVerification.safeParse(v).success).toBe(false);
  });
});

describe("procedures", () => {
  test("treasurer and patronage stubs exist with their inputs", () => {
    const t = contract.money.treasurer;
    expect(inputOf(t.refundRequests.list).parse({})).toMatchObject({ state: "outstanding" });
    expect(inputOf(t.refundRequests.resolve).safeParse({ requestId: id(1), outcome: "refunded" }).success).toBe(true);
    expect(inputOf(t.refundRequests.resolve).safeParse({ requestId: id(1), outcome: "maybe" }).success).toBe(false);
    expect(inputOf(t.transfers).safeParse({ periodStart: at, status: "created" }).success).toBe(true);
    expect(inputOf(contract.coop.patronage.payouts).safeParse({ periodId: id(1) }).success).toBe(true);
    expect(outputOf(contract.coop.patronage.pay).safeParse({ state: "approved", created: 3 }).success).toBe(true);
  });

  test("the heartbeat may move a DVR session", () => {
    expect(outputOf(contract.playback.heartbeat).parse({ ok: true, dvrSwitchTo: "https://o.test/dvr.m3u8" })).toEqual({
      ok: true,
      dvrSwitchTo: "https://o.test/dvr.m3u8",
    });
  });
});

describe("watch rooms", () => {
  test("edgeWallclock: optional, nullable, on reports and the client frame", () => {
    const report = { playheadWallclock: at, mode: "live", at: 1 };
    expect(RoomSyncReport.safeParse(report).success).toBe(true);
    expect(RoomSyncReport.safeParse({ ...report, edgeWallclock: at }).success).toBe(true);
    expect(RoomSyncReport.safeParse({ ...report, mode: "dvr", edgeWallclock: null }).success).toBe(true);
    const frame = { op: "room.sync", roomId: id(1), playheadWallclock: at, mode: "live", nonce: "n1" };
    expect(ClientFrame.safeParse(frame).success).toBe(true);
    expect(ClientFrame.safeParse({ ...frame, edgeWallclock: at }).success).toBe(true);
  });
});

describe("jobs", () => {
  test("names and payloads; job ids BullMQ accepts", () => {
    expect(Object.values(B8_JOBS).toSorted()).toEqual(
      [
        "import-record-expiry",
        "patronage-payout",
        "payout-transfers",
        "portability-incoming-cleanup",
        "refund-reconcile",
      ].toSorted(),
    );
    expect(PayoutTransferJob.safeParse({ payoutId: id(1) }).success).toBe(true);
    expect(PatronagePayoutJob.safeParse({ periodId: id(1), userId: id(2) }).success).toBe(true);
    // BullMQ refuses a custom id with exactly one colon (it reads it as a repeat key).
    for (const jobId of [payoutTransferJobId(id(1)), patronagePayoutJobId(id(1), id(2))])
      expect(jobId.split(":")).toHaveLength(1);
  });
});
