// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `channels.mediaSettings` / `updateMediaSettings`: captions and DVR settings (W2 contract step). */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { dto } from "@commonair/contracts";
import { schema } from "@commonair/db";
import type { z } from "zod";
import { checkMaskWords, clampDvrWindow } from "../src/channels/media-settings.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Settings = z.infer<typeof dto.ChannelMediaSettings>;
let api: TestApi;
let owner: Awaited<ReturnType<typeof signUpAndSignIn>>;
let other: Awaited<ReturnType<typeof signUpAndSignIn>>;
const env = () => api.deps.env as unknown as { DVR_MAX_WINDOW_SECONDS: number };

beforeAll(async () => {
  api = await startApi();
  owner = await signUpAndSignIn(api);
  other = await signUpAndSignIn(api);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const url = () => `/api/channels/${owner.username}/media-settings`;

describe("media settings", () => {
  test("defaults: captions follow the instance default (off), DVR on with a 30 min window", async () => {
    const r = await owner.client.call<Settings>("GET", url());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      captions: { enabled: null, spokenLanguage: null, maskWords: [] },
      captionsInstanceDefault: false,
      captionsState: "off",
      dvr: { enabled: true, windowSeconds: 1800 },
      dvrMaxWindowSeconds: 7200,
    });
  });

  test("owner only: anonymous and other users are refused", async () => {
    expect((await client(api).call("GET", url())).status).toBe(401);
    expect((await other.client.call("GET", url())).status).toBe(403);
    expect((await other.client.call("PATCH", url(), { dvr: { enabled: false } })).status).toBe(403);
  });

  test("a patch keeps what it leaves out, clamps the window to the cap and audits field names only", async () => {
    const r = await owner.client.call<Settings>("PATCH", url(), {
      captions: { enabled: true, maskWords: ["  darn ", "darn", "heck"] },
      dvr: { windowSeconds: 86_400 },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.captions).toEqual({ enabled: true, spokenLanguage: null, maskWords: ["darn", "heck"] });
    expect(r.body.dvr).toEqual({ enabled: true, windowSeconds: 7200 });
    const [c] = await api.db.db.select().from(schema.channels).where(eq(schema.channels.slug, owner.username));
    expect(c?.dvrWindowSeconds).toBe(7200);

    const again = await owner.client.call<Settings>("PATCH", url(), { captions: { spokenLanguage: "es" } });
    expect(again.body.captions).toEqual({ enabled: true, spokenLanguage: "es", maskWords: ["darn", "heck"] });
    expect(again.body.dvr.windowSeconds).toBe(7200);

    const rows = await api.db.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, c!.id), eq(schema.auditLog.action, "channel.media_settings.update")));
    expect(rows.map((a) => a.details)).toEqual([
      { changed: ["captions.enabled", "captions.maskWords", "dvr.windowSeconds"] },
      { changed: ["captions.spokenLanguage"] },
    ]);
    expect(JSON.stringify(rows)).not.toContain("darn");
  });

  test("a lowered cap clamps the stored window on read", async () => {
    const before = env().DVR_MAX_WINDOW_SECONDS;
    env().DVR_MAX_WINDOW_SECONDS = 600;
    try {
      const r = await owner.client.call<Settings>("GET", url());
      expect(r.body).toMatchObject({ dvr: { windowSeconds: 600 }, dvrMaxWindowSeconds: 600 });
    } finally {
      env().DVR_MAX_WINDOW_SECONDS = before;
    }
  });

  test("a cap under a minute turns DVR off instance-wide", async () => {
    const before = env().DVR_MAX_WINDOW_SECONDS;
    env().DVR_MAX_WINDOW_SECONDS = 0;
    try {
      const r = await owner.client.call<Settings>("GET", url());
      expect(r.body).toMatchObject({ dvr: { enabled: false, windowSeconds: 60 }, dvrMaxWindowSeconds: 0 });
    } finally {
      env().DVR_MAX_WINDOW_SECONDS = before;
    }
  });

  test("an unsafe mask pattern is refused and nothing changes", async () => {
    const r = await owner.client.call<{ data?: { requirement?: string } }>("PATCH", url(), {
      captions: { maskWords: ["(a+)+$"] },
      dvr: { enabled: false },
    });
    expect(r.status).toBe(412);
    expect(r.body.data?.requirement).toBe("mask_pattern");
    const now = await owner.client.call<Settings>("GET", url());
    expect(now.body.captions.maskWords).toEqual(["darn", "heck"]);
    expect(now.body.dvr.enabled).toBe(true);
  });
});

describe("helpers", () => {
  test("clampDvrWindow keeps the column floor and the cap", () => {
    expect(clampDvrWindow(1800, 7200)).toBe(1800);
    expect(clampDvrWindow(9000, 7200)).toBe(7200);
    expect(clampDvrWindow(1800, 0)).toBe(60);
    expect(clampDvrWindow(30, 7200)).toBe(60);
  });

  test("checkMaskWords trims, drops empties and de-duplicates", () => {
    expect(checkMaskWords([" a ", "a", "", "b"])).toEqual(["a", "b"]);
    expect(() => checkMaskWords(["(x*)*y"])).toThrow(/Mask pattern refused/);
  });
});
