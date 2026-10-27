// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isContractProcedure, type AnyContractProcedure } from "@orpc/contract";
import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { contract } from "../src/api/router.ts";
import {
  BusEvent,
  EVENTS,
  EVENT_TYPES,
  INTERNAL_EVENT_TYPES,
  PUBLIC_EVENT_TYPES,
  isInternalEvent,
  signWebhook,
  verifyWebhook,
} from "../src/events.ts";
import { ModerationT0Job, ModerationScores } from "../src/internal.ts";
import { SCOPES } from "../src/scopes.ts";
import { generateOpenApi } from "../src/openapi.ts";
import { BotConfig, PatronageWeights } from "../src/shapes.ts";
import { ClientFrame, ServerFrame } from "../src/chat.ts";

function procedures(node: unknown, path: string[] = []): [string, AnyContractProcedure][] {
  if (isContractProcedure(node)) return [[path.join("."), node]];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => procedures(v, [...path, k]));
}
const all = procedures(contract);

describe("API contract", () => {
  test("every procedure has a method, path, summary and tag", () => {
    for (const [name, p] of all) {
      const r = p["~orpc"].route;
      expect.soft(r.method, name).toBeDefined();
      expect.soft(r.path, name).toMatch(/^\//);
      expect.soft(r.summary, name).toBeTruthy();
      expect.soft(r.tags?.length, name).toBeGreaterThan(0);
    }
  });

  test("method + path pairs are unique", () => {
    const seen = new Map<string, string>();
    for (const [name, p] of all) {
      const key = `${p["~orpc"].route.method} ${p["~orpc"].route.path}`;
      expect(seen.get(key), `${name} duplicates ${seen.get(key)}`).toBeUndefined();
      seen.set(key, name);
    }
  });

  test("every path parameter is a field of the input schema", () => {
    for (const [name, p] of all) {
      const params = [...(p["~orpc"].route.path ?? "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
      if (params.length === 0) continue;
      const input = p["~orpc"].inputSchema as z.ZodObject | undefined;
      expect(input, name).toBeInstanceOf(z.ZodObject);
      for (const param of params) expect.soft(Object.keys(input!.shape), `${name} {${param}}`).toContain(param);
    }
  });

  test("declared scopes exist", () => {
    for (const [name, p] of all)
      for (const s of p["~orpc"].meta.scopes ?? []) expect.soft(SCOPES, name).toHaveProperty(s);
  });

  test("generates a valid OpenAPI 3.1 document", async () => {
    const doc = await generateOpenApi({
      title: "Test",
      version: "0.0.0",
      serverUrl: "http://localhost:3001/api",
      sourceUrl: "https://example.invalid/src",
    });
    expect(doc.openapi).toMatch(/^3\.1/);
    const ops = Object.values(doc.paths ?? {}).flatMap((p) => Object.keys(p ?? {}));
    expect(ops.length).toBe(all.length);
  });
});

describe("events", () => {
  test("every event declares known scopes and has a payload schema", () => {
    for (const t of EVENT_TYPES) {
      const e = EVENTS[t];
      for (const s of e.scopes) expect(SCOPES).toHaveProperty(s);
      expect(e.payload).toBeInstanceOf(z.ZodObject);
    }
  });

  test("internal trust & safety and co-op events are never offered to apps or put on the bus", () => {
    expect(INTERNAL_EVENT_TYPES.toSorted()).toEqual([
      "account.action.recorded",
      "account.action.reversed",
      "coop.council.recomputed",
      "coop.council.response",
      "coop.election.update",
      "coop.membership.update",
      "coop.patronage.update",
      "coop.proposal.comment",
      "coop.share.update",
      "coop.vote.cast",
      "dmca.content.restored",
      "dmca.counter.received",
      "dmca.counter.suit_filed",
      "dmca.notice.decided",
      "dmca.notice.received",
      "legal.hold.placed",
      "moderation.case.resolved",
      "moderation.flagged",
      "moderation.restriction",
      "moderation.t0.media_preserved",
      "ncii.request.decided",
      "ncii.request.received",
      "ncmec.draft.created",
    ]);
    for (const t of INTERNAL_EVENT_TYPES) {
      expect(PUBLIC_EVENT_TYPES).not.toContain(t);
      expect(isInternalEvent(t)).toBe(true);
      // Ids and enums only: no field that could carry personal data, URLs or evidence keys.
      for (const k of Object.keys(EVENTS[t].payload.shape))
        expect(k).not.toMatch(/email|name|url|key|(^|_)ip(_|$)|login|frame|bytes|hash|pdq|note|reason$|choice|body/);
      // Secret ballot (e5-selectors.md): a vote event names the proposal only.
      expect(Object.keys(EVENTS["coop.vote.cast"].payload.shape)).toEqual(["proposal_id"]);
    }
    expect(PUBLIC_EVENT_TYPES.length + INTERNAL_EVENT_TYPES.length).toBe(EVENT_TYPES.length);
    expect(isInternalEvent("stream.online")).toBe(false);
    expect(isInternalEvent("toString")).toBe(false);
    const ev = { id: "e", version: "1", channelId: null, payload: {}, occurredAt: "t" };
    expect(BusEvent.safeParse({ ...ev, type: "moderation.flagged" }).success).toBe(false);
    expect(BusEvent.safeParse({ ...ev, type: "stream.online" }).success).toBe(true);
    const subscribe = contract.developer.events.subscribe["~orpc"].inputSchema as z.ZodObject;
    expect(subscribe.shape.type.safeParse("moderation.flagged").success).toBe(false);
    expect(
      EVENTS["moderation.t0.media_preserved"].payload.safeParse({
        case_id: "case",
        hold_id: "hold",
        source_subject_type: "broadcast",
        source_subject_id: "subject",
        evidence_id: "evidence",
        kind: "frame",
        status: "object_preserved",
      }).success,
    ).toBe(true);
    expect(
      EVENTS["moderation.t0.media_preserved"].payload.safeParse({
        case_id: "case",
        hold_id: "hold",
        source_subject_type: "broadcast",
        source_subject_id: "subject",
        evidence_id: null,
        kind: null,
        status: "reconciliation_complete",
        object_key: "must-not-be-a-contract-field",
      }).success,
    ).toBe(true);
  });

  test("classifier scores leave unscored categories absent and stay in [0, 1]", () => {
    expect(ModerationScores.parse({ sexual: 0.5 })).toEqual({ sexual: 0.5 });
    expect(ModerationScores.safeParse({ sexual: 1.2 }).success).toBe(false);
    expect(ModerationScores.safeParse({ nudity: 0.2 }).success).toBe(false);
    expect(ModerationT0Job.safeParse({ evidence: [] }).success).toBe(false);
  });

  test("webhook signatures verify, and tampering, wrong secrets and stale timestamps fail", async () => {
    const ts = new Date().toISOString();
    const sig = await signWebhook("s3cret-s3cret", "msg-1", ts, '{"a":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await verifyWebhook("s3cret-s3cret", "msg-1", ts, '{"a":1}', sig)).toBe(true);
    expect(await verifyWebhook("s3cret-s3cret", "msg-1", ts, '{"a":2}', sig)).toBe(false);
    expect(await verifyWebhook("other-secret", "msg-1", ts, '{"a":1}', sig)).toBe(false);
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    expect(
      await verifyWebhook(
        "s3cret-s3cret",
        "msg-1",
        old,
        '{"a":1}',
        await signWebhook("s3cret-s3cret", "msg-1", old, '{"a":1}'),
      ),
    ).toBe(false);
  });
});

describe("currency", () => {
  test("uses ISO 4217 minor units, not engine Intl data", async () => {
    const { minorUnits } = await import("../src/currency.ts");
    expect([minorUnits("usd"), minorUnits("JPY"), minorUnits("kwd"), minorUnits("huf"), minorUnits("iqd")]).toEqual([
      2, 0, 3, 2, 3,
    ]);
  });
});

describe("shapes", () => {
  test("bot config defaults are complete", () => {
    const c = BotConfig.parse({});
    expect(c.loyalty.enabled).toBe(true);
    expect(c.filters.spam.enabled).toBe(true);
  });
  test("patronage weights must sum to 1", () => {
    const w = {
      revenue: 0.5,
      streamingHours: 0.2,
      relayBandwidth: 0.2,
      viewerHours: 0.1,
      dailyStreamingHourCap: 8,
      viewerHoursChannelCap: 0.1,
    };
    expect(PatronageWeights.safeParse(w).success).toBe(true);
    expect(PatronageWeights.safeParse({ ...w, revenue: 0.6 }).success).toBe(false);
  });
  test("chat frames parse", () => {
    expect(ClientFrame.parse({ op: "send", channel: "abc", body: "hi" }).op).toBe("send");
    expect(ServerFrame.safeParse({ op: "notice", channel: null, code: "msg_slowmode", text: "slow" }).success).toBe(
      true,
    );
    expect(ClientFrame.safeParse({ op: "send", channel: "abc", body: "x".repeat(501) }).success).toBe(false);
  });
});
