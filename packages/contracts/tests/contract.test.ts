// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isContractProcedure, type AnyContractProcedure } from "@orpc/contract";
import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { contract } from "../src/api/router.ts";
import { EVENTS, EVENT_TYPES, signWebhook, verifyWebhook } from "../src/events.ts";
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
