// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 5 schedule: `channels.schedule.get` (public) and `.set` (owner, replaces the
 * whole schedule), `Channel.nextStreamAt` on `channels.get`, and the calendar feed raw route.
 *
 * This file owns its database (`startApi` → `createTestDatabase()`).
 */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { schema } from "@commonair/db";
import { client, signUpAndSignIn, startApi, uniqueName, type TestApi } from "./harness.ts";

let api: TestApi;
let category: { id: string; slug: string; name: string };
beforeAll(async () => {
  api = await startApi();
  const slug = uniqueName("cat");
  const [row] = await api.db.db.insert(schema.categories).values({ slug, name: "Just Chatting" }).returning();
  if (!row) throw new Error("no category");
  category = { id: row.id, slug: row.slug, name: row.name };
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

interface Schedule {
  timezone: string;
  slots: { id: string; weekday: number; startLocal: string; durationMinutes: number; title: string | null }[];
  oneOffs: { id: string; startsAt: string; cancelsSlotId: string | null; title: string | null }[];
  upcoming: {
    startsAt: string;
    endsAt: string;
    slotId: string | null;
    oneOffId: string | null;
    title: string | null;
  }[];
  feedPath: string;
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

describe("channels.schedule", () => {
  test("a channel with no schedule: UTC, empty lists, no next stream", async () => {
    const owner = await signUpAndSignIn(api);
    const r = await client(api).call<Schedule>("GET", `/api/channels/${owner.username}/schedule`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      timezone: "UTC",
      slots: [],
      oneOffs: [],
      upcoming: [],
      feedPath: `/api/channels/${owner.username}/schedule.ics`,
    });
    const ch = await client(api).call<{ nextStreamAt: string | null }>("GET", `/api/channels/${owner.username}`);
    expect(ch.body.nextStreamAt).toBeNull();
    expect((await client(api).call("GET", "/api/channels/nobody_here_x/schedule")).status).toBe(404);
  });

  test("set: owner only, validated, replaces, and drives nextStreamAt and the feed", async () => {
    const owner = await signUpAndSignIn(api);
    const other = await signUpAndSignIn(api);
    const path = `/api/channels/${owner.username}/schedule`;
    const slots = [
      { weekday: 5, startLocal: "19:30", durationMinutes: 180, title: "Campaign night", categoryId: category.id },
      { weekday: 2, startLocal: "23:30", durationMinutes: 120, title: null, categoryId: null },
    ];
    const special = {
      startsAt: inDays(3),
      durationMinutes: 90,
      title: "Charity, special",
      categoryId: null,
      cancelsSlot: null,
    };
    const body = { timezone: "America/Toronto", slots, oneOffs: [special] };

    expect((await client(api).call("PUT", path, body)).status).toBe(401);
    expect((await other.client.call("PUT", path, body)).status).toBe(403);

    const bad = async (patch: object) => (await owner.client.call("PUT", path, { ...body, ...patch })).status;
    expect(await bad({ timezone: "Mars/Olympus_Mons" })).toBe(400);
    expect(await bad({ timezone: "+01:00" })).toBe(400);
    expect(await bad({ slots: [{ ...slots[0], categoryId: crypto.randomUUID() }] })).toBe(400);
    expect(await bad({ slots: [{ ...slots[0], durationMinutes: 5 }] })).toBe(400);
    expect(await bad({ oneOffs: [{ ...special, cancelsSlot: 7 }] })).toBe(400);
    // A skip that is not exactly one of its slot's streams.
    expect(await bad({ oneOffs: [{ ...special, cancelsSlot: 0 }] })).toBe(400);

    const set = await owner.client.call<Schedule>("PUT", path, body);
    expect(set.status).toBe(200);
    expect(set.body.timezone).toBe("America/Toronto");
    expect(set.body.slots).toHaveLength(2);
    expect(set.body.slots.map((s) => [s.weekday, s.startLocal])).toEqual([
      [2, "23:30"],
      [5, "19:30"],
    ]);
    expect(set.body.slots[1]).toMatchObject({ title: "Campaign night", category });
    expect(set.body.oneOffs).toEqual([
      expect.objectContaining({ startsAt: special.startsAt, title: "Charity, special", cancelsSlotId: null }),
    ]);
    const upcoming = set.body.upcoming;
    // Two weekly slots over 28 days plus the one-off, soonest first.
    expect(upcoming.length).toBeGreaterThanOrEqual(9);
    expect(upcoming.length).toBeLessThanOrEqual(10);
    const starts = upcoming.map((o) => Date.parse(o.startsAt));
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(upcoming.some((o) => o.oneOffId !== null && o.title === "Charity, special")).toBe(true);

    const ch = await client(api).call<{ nextStreamAt: string | null }>("GET", `/api/channels/${owner.username}`);
    expect(ch.body.nextStreamAt).toBe(upcoming[0]?.startsAt);
    const pub = await client(api).call<Schedule>("GET", path);
    expect(pub.body).toMatchObject({ timezone: "America/Toronto", upcoming });

    // Skip the first Friday stream: it leaves the upcoming list, the skip is listed as a one-off.
    const friday = set.body.slots[1];
    const firstFriday = upcoming.find((o) => o.slotId === friday?.id);
    if (!firstFriday) throw new Error("no Friday occurrence");
    const withSkip = await owner.client.call<Schedule>("PUT", path, {
      ...body,
      // The Friday slot is index 0 of the input, whatever order `get` lists them in.
      oneOffs: [
        special,
        { startsAt: firstFriday.startsAt, durationMinutes: 180, title: null, categoryId: null, cancelsSlot: 0 },
      ],
    });
    expect(withSkip.status).toBe(200);
    const newFriday = withSkip.body.slots.find((s) => s.weekday === 5);
    expect(withSkip.body.oneOffs.find((o) => o.cancelsSlotId !== null)).toMatchObject({
      startsAt: firstFriday.startsAt,
      cancelsSlotId: newFriday?.id,
    });
    expect(withSkip.body.upcoming.some((o) => o.startsAt === firstFriday.startsAt)).toBe(false);
    expect(withSkip.body.upcoming).toHaveLength(upcoming.length - 1);

    // The feed: one VEVENT per upcoming occurrence; `?next=1` is the next one alone.
    const feed = await fetch(`${api.url}${withSkip.body.feedPath}`);
    expect(feed.status).toBe(200);
    expect(feed.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(feed.headers.get("cache-control")).toBe("public, max-age=300");
    const text = await feed.text();
    expect(text.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(withSkip.body.upcoming.length);
    expect(text).toContain("SUMMARY:Charity\\, special");
    expect(text).toContain(`URL:`);
    const next = await fetch(`${api.url}${withSkip.body.feedPath}?next=1`);
    expect(next.headers.get("content-disposition")).toContain("attachment");
    expect((await next.text()).match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect((await fetch(`${api.url}${withSkip.body.feedPath}`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${api.url}/api/channels/nobody_here_x/schedule.ics`)).status).toBe(404);

    // Replace with nothing: the rows go, the next stream with them.
    const cleared = await owner.client.call<Schedule>("PUT", path, {
      timezone: "Europe/Paris",
      slots: [],
      oneOffs: [],
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ timezone: "Europe/Paris", slots: [], oneOffs: [], upcoming: [] });
    const [ownerChannel] = await api.db.db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.slug, owner.username));
    if (!ownerChannel) throw new Error("no channel");
    const left = await api.db.db
      .select()
      .from(schema.channelScheduleSlots)
      .where(eq(schema.channelScheduleSlots.channelId, ownerChannel.id));
    expect(left).toHaveLength(0);
    const after = await client(api).call<{ nextStreamAt: string | null }>("GET", `/api/channels/${owner.username}`);
    expect(after.body.nextStreamAt).toBeNull();
  }, 60_000);

  test("one-offs that ended are not listed; a suspended channel has no upcoming streams", async () => {
    const owner = await signUpAndSignIn(api);
    const path = `/api/channels/${owner.username}/schedule`;
    const set = await owner.client.call<Schedule>("PUT", path, {
      timezone: "UTC",
      slots: [],
      oneOffs: [
        { startsAt: inDays(-1), durationMinutes: 60, title: "Yesterday", categoryId: null, cancelsSlot: null },
        { startsAt: inDays(1), durationMinutes: 60, title: "Tomorrow", categoryId: null, cancelsSlot: null },
      ],
    });
    expect(set.status).toBe(200);
    expect(set.body.oneOffs.map((o) => o.title)).toEqual(["Tomorrow"]);
    expect(set.body.upcoming.map((o) => o.title)).toEqual(["Tomorrow"]);
    await api.db.db
      .update(schema.channels)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.channels.slug, owner.username));
    const r = await client(api).call<Schedule>("GET", path);
    expect(r.body.upcoming).toEqual([]);
    expect(r.body.oneOffs).toHaveLength(1);
  }, 60_000);
});
