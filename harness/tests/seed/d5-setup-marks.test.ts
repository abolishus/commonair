// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** d5-dashboard: seed-social marks "Bring your audience" for the established demo streamers only. */
import { describe, expect, test } from "vite-plus/test";
import { NOT_SEEDED } from "../../src/seed/coverage.ts";
import { createRng } from "../../src/seed/prng.ts";
import { SEED_SCALES } from "../../src/seed/scale.ts";
import { unit } from "../../src/seed/social.ts";
import type { SessionSource } from "../../src/seed/social/api.ts";
import { planSocial } from "../../src/seed/social/plan.ts";
import { AUDIENCE_MARKED, seedSetupMarks } from "../../src/seed/social/setup.ts";

const P = planSocial(createRng(7).fork("social"), SEED_SCALES.small, new Date("2026-11-01T12:00:00.000Z"));

describe("seed-social checklist marks", () => {
  test("seed-social owns channel_setup_steps and it is no longer NOT_SEEDED", () => {
    expect(unit.tables).toContain("channel_setup_steps");
    expect(Object.keys(NOT_SEEDED)).not.toContain("channel_setup_steps");
  });

  test("streamer1 and streamer2 mark the audience step on their own channels; streamer3 does not", async () => {
    const calls: { as: string; input: unknown }[] = [];
    const sessions = {
      as: async (h: string) => ({
        api: { client: { stream: { setupMark: async (input: unknown) => calls.push({ as: h, input }) } } },
      }),
    } as unknown as SessionSource;
    const out = await seedSetupMarks(sessions, P, new AbortController().signal);
    expect(calls.map((c) => c.as)).toEqual([...AUDIENCE_MARKED]);
    expect(calls.map((c) => c.as)).not.toContain("streamer3");
    for (const c of calls) {
      const slug = P.channels.find((x) => x.ownerHandle === c.as)?.slug;
      expect(c.input).toEqual({ channel: slug, step: "bring_your_audience" });
    }
    expect(out.rows).toEqual({ channel_setup_steps: AUDIENCE_MARKED.length });
  });

  test("a failing mark names the streamer", async () => {
    const sessions = {
      as: async () => ({ api: { client: { stream: { setupMark: async () => Promise.reject(new Error("boom")) } } } }),
    } as unknown as SessionSource;
    await expect(seedSetupMarks(sessions, P, new AbortController().signal)).rejects.toThrow(
      /bring your audience" as streamer1 failed: Error: boom/,
    );
  });
});
