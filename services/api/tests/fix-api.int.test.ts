// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Design-overhaul fix-first items against a real database: F8 (one live `vote_open` per proposal,
 * named), F9 (a category's recently live channels; search over live stream titles and tags),
 * F10 (marketing usernames reserved), F11 (the verification link's callback). F12's provider
 * return URLs are asserted on the Stripe calls in money-stripe.int.test.ts.
 */
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { mediaPath } from "@commonair/contracts/internal";
import { schema, uuidv7, type Database } from "@commonair/db";
import { FAST_GOVERNANCE } from "@commonair/db/testing";
import { advanceProposals } from "@commonair/governance";
import {
  client,
  mailTo,
  signUpAndSignIn,
  solveAltcha,
  startApi,
  uniqueName,
  waitFor,
  type TestApi,
} from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi({ governance: FAST_GOVERNANCE });
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const owner = () => api.db.db;
/** The least-privilege app role, through every governance trigger (as the worker runs). */
const app = (): Database => api.db.app.db;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;

describe("F8: vote_open in the inbox", () => {
  interface Item {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    readAt: string | null;
  }
  let member: Account;

  /** A proposal taken to voting by the lifecycle step, which writes the `vote_open` rows. */
  async function openVote(authorId: string, title: string): Promise<string> {
    const [p] = await app()
      .insert(schema.proposals)
      .values({ authorId, title, body: "Body", kind: "ordinary", affectsCreators: false, changes: [] })
      .returning({ id: schema.proposals.id });
    if (!p) throw new Error("no proposal");
    await app().update(schema.proposals).set({ status: "discussion" }).where(eq(schema.proposals.id, p.id));
    await sleep(20); // the 0 s discussion period must strictly pass
    await advanceProposals(app());
    const [row] = await owner().select().from(schema.proposals).where(eq(schema.proposals.id, p.id));
    if (row?.status !== "voting") throw new Error(`the vote did not open (${row?.status})`);
    return p.id;
  }
  const inbox = async (unreadOnly = false) => {
    const r = await member.client.call<{ items: Item[] }>(
      "GET",
      `/api/me/notifications?limit=50&unreadOnly=${unreadOnly}`,
    );
    expect(r.status).toBe(200);
    return r.body.items.filter((i) => i.type === "vote_open");
  };
  const unread = async () => {
    const r = await member.client.call<{ count: number }>("GET", "/api/notifications/unread-count");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.count;
  };

  let closedId = "";
  let openId = "";
  beforeAll(async () => {
    member = await signUpAndSignIn(api);
    await app()
      .insert(schema.memberships)
      .values({ userId: member.userId, class: "worker", basis: "board_appointment" });
    // One proposal voted and decided (rejected: no ballots), then one still voting.
    closedId = await openVote(member.userId, "Closed proposal");
    const [closed] = await owner().select().from(schema.proposals).where(eq(schema.proposals.id, closedId));
    await sleep(Math.max(0, (closed?.votingEndsAt?.getTime() ?? 0) - Date.now()) + 50);
    await advanceProposals(app());
    const [decided] = await owner().select().from(schema.proposals).where(eq(schema.proposals.id, closedId));
    if (decided?.status !== "rejected") throw new Error(`the closed proposal is ${decided?.status}, not rejected`);
    openId = await openVote(member.userId, "Lower the platform fee");
    // A second copy for the open proposal, as a re-run or a seed would write.
    const [existing] = (
      await owner()
        .select()
        .from(schema.notifications)
        .where(and(eq(schema.notifications.userId, member.userId), eq(schema.notifications.type, "vote_open")))
    ).filter((n) => n.payload.proposalId === openId);
    if (!existing) throw new Error("the lifecycle wrote no vote_open row for the open proposal");
    await owner()
      .insert(schema.notifications)
      .values({
        id: uuidv7(),
        userId: member.userId,
        type: "vote_open",
        payload: existing.payload,
        createdAt: new Date(existing.createdAt.getTime() + 1_000),
      });
  }, 60_000);

  test("the lifecycle notified the member once per proposal, by id only", async () => {
    const all = await owner()
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, member.userId), eq(schema.notifications.type, "vote_open")));
    expect(all.filter((n) => n.payload.proposalId === closedId)).toHaveLength(1);
    expect(all.filter((n) => n.payload.proposalId === openId)).toHaveLength(2); // one plus the planted copy
    // No free text in the stored payload (ADR 0004): the title is joined at read time.
    for (const n of all) expect(n.payload.title).toBeUndefined();
  });

  test("the inbox shows one vote_open, for the proposal still voting, named by its title", async () => {
    const items = await inbox();
    expect(items).toHaveLength(1);
    expect(items[0]?.payload).toMatchObject({ proposalId: openId, kind: "ordinary", title: "Lower the platform fee" });
    expect(await inbox(true)).toHaveLength(1);
  });

  test("the unread badge counts it once", async () => {
    expect(await unread()).toBe(1);
  });

  test("marking the shown row read marks its hidden copy too", async () => {
    const [shown] = await inbox();
    if (!shown) throw new Error("nothing shown");
    const r = await member.client.call("POST", "/api/me/notifications/read", { ids: [shown.id] });
    expect(r.status).toBe(200);
    const left = await owner()
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, member.userId),
          eq(schema.notifications.type, "vote_open"),
          isNull(schema.notifications.readAt),
        ),
      );
    // Only the closed proposal's row stays unread, and it is never delivered.
    expect(left.map((n) => n.payload.proposalId)).toEqual([closedId]);
    expect(await unread()).toBe(0);
    expect(await inbox(true)).toHaveLength(0);
    expect(await inbox()).toHaveLength(1);
  });

  test("other members' rows are untouched by the mark", async () => {
    const other = await signUpAndSignIn(api);
    await owner()
      .insert(schema.notifications)
      .values({ id: uuidv7(), userId: other.userId, type: "vote_open", payload: { proposalId: openId } });
    const [shown] = await inbox();
    await member.client.call("POST", "/api/me/notifications/read", { ids: [shown?.id ?? ""] });
    const r = await other.client.call<{ count: number }>("GET", "/api/notifications/unread-count");
    expect(r.body.count).toBe(1);
  });
});

describe("F9: categories and search", () => {
  let streamerA: Account;
  let streamerB: Account;
  let streamerC: Account;
  let liveTitle: Account;
  let liveTag: Account;
  let offlineStreamer: Account;
  let viewerAccount: Account;
  let cooking = "";
  let gaming = "";
  let mature = "";

  async function category(slug: string, isMature = false): Promise<string> {
    const [c] = await owner()
      .insert(schema.categories)
      .values({ slug, name: slug, mature: isMature })
      .returning({ id: schema.categories.id });
    if (!c) throw new Error("no category");
    return c.id;
  }
  async function channelOf(a: Account) {
    const [c] = await owner().select().from(schema.channels).where(eq(schema.channels.ownerId, a.userId));
    if (!c) throw new Error("no channel");
    return c;
  }
  /** An ended broadcast `minutesAgo` minutes ago. */
  async function ended(
    a: Account,
    categoryId: string | null,
    minutesAgo: number,
    opts: { mature?: boolean; restricted?: boolean; kind?: "live" | "rehearsal" } = {},
  ) {
    const c = await channelOf(a);
    const end = new Date(Date.now() - minutesAgo * 60_000);
    await owner()
      .insert(schema.broadcasts)
      .values({
        channelId: c.id,
        kind: opts.kind ?? "live",
        ingestProtocol: "rtmp",
        path: mediaPath(c.slug),
        title: `${c.slug} earlier`,
        categoryId,
        mature: opts.mature ?? false,
        startedAt: new Date(end.getTime() - 3_600_000),
        endedAt: end,
        restrictedAt: opts.restricted ? end : null,
      });
  }
  async function goLive(a: Account, title: string, tags: string[] = []) {
    const c = await channelOf(a);
    const [b] = await owner()
      .insert(schema.broadcasts)
      .values({ channelId: c.id, ingestProtocol: "rtmp", path: mediaPath(c.slug), title, startedAt: new Date() })
      .returning();
    if (!b) throw new Error("no broadcast");
    await owner()
      .update(schema.channels)
      .set({ liveBroadcastId: b.id, title: "Evening stream", tags })
      .where(eq(schema.channels.id, c.id));
  }

  beforeAll(async () => {
    [streamerA, streamerB, streamerC, liveTitle, liveTag, offlineStreamer, viewerAccount] = await Promise.all([
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
    ]);
    const suffix = crypto.randomUUID().slice(0, 6);
    cooking = await category(`cooking-${suffix}`);
    gaming = await category(`gaming-${suffix}`);
    mature = await category(`mature-${suffix}`, true);
    // A: cooked 10 min ago. B: cooked 30 min ago, then gamed 5 min ago. C: cooked 20 min ago, live now.
    await ended(streamerA, cooking, 10);
    await ended(streamerB, cooking, 30);
    await ended(streamerB, gaming, 5);
    await ended(streamerC, cooking, 20);
    await goLive(streamerC, "still cooking");
    // Never listed: a mature cooking broadcast, a restricted one, a rehearsal.
    await ended(liveTitle, cooking, 1, { mature: true });
    await ended(liveTag, cooking, 2, { restricted: true });
    await ended(offlineStreamer, cooking, 3, { kind: "rehearsal" });
    await ended(viewerAccount, mature, 4);

    // Search fixtures: two live streams that match only on stream title / tag, one offline streamer
    // and one viewer account that match on their display name.
    await goLive(liveTitle, "chill lofi beats to study to");
    await goLive(liveTag, "study session", ["lofi", "study"]);
    await owner()
      .update(schema.channels)
      .set({ displayName: "Lofi Radio", followerCount: 5 })
      .where(eq(schema.channels.ownerId, offlineStreamer.userId));
    await ended(offlineStreamer, null, 60);
    await owner()
      .update(schema.channels)
      .set({ displayName: "Lofi Lover" })
      .where(eq(schema.channels.ownerId, viewerAccount.userId));
  }, 120_000);

  const slugOf = (a: Account) => a.username;
  const recentlyLive = async (slug: string, query = "") => {
    const r = await client(api).call<{ channel: { slug: string }; category: { slug: string } | null }[]>(
      "GET",
      `/api/categories/${slug}/recently-live${query}`,
    );
    return r;
  };

  test("a category lists the channels recently live in it, newest first, live ones excluded", async () => {
    const [cat] = await owner().select().from(schema.categories).where(eq(schema.categories.id, cooking));
    const r = await recentlyLive(cat?.slug ?? "");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // B streamed something else since, but its last cooking broadcast still counts.
    expect(r.body.map((c) => c.channel.slug)).toEqual([slugOf(streamerA), slugOf(streamerB)]);
    expect(r.body.every((c) => c.category?.slug === cat?.slug)).toBe(true);
  });

  test("the limit applies", async () => {
    const [cat] = await owner().select().from(schema.categories).where(eq(schema.categories.id, cooking));
    const r = await recentlyLive(cat?.slug ?? "", "?limit=1");
    expect(r.body.map((c) => c.channel.slug)).toEqual([slugOf(streamerA)]);
  });

  test("a mature category is empty for anyone who has not opted in; an unknown one is 404", async () => {
    const [cat] = await owner().select().from(schema.categories).where(eq(schema.categories.id, mature));
    const r = await recentlyLive(cat?.slug ?? "", "?includeMature=true");
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
    expect((await recentlyLive("no-such-category")).status).toBe(404);
  });

  test("search matches live stream titles and tags, live channels first, viewer accounts last", async () => {
    const r = await client(api).call<{ channels: { slug: string; live: unknown; followerCount: number }[] }>(
      "GET",
      "/api/search?q=lofi",
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const slugs = r.body.channels.map((c) => c.slug);
    expect(new Set(slugs.slice(0, 2))).toEqual(new Set([slugOf(liveTitle), slugOf(liveTag)]));
    expect(r.body.channels.slice(0, 2).every((c) => c.live !== null)).toBe(true);
    expect(slugs.slice(2)).toEqual([slugOf(offlineStreamer), slugOf(viewerAccount)]);
  });

  test("a # tag query matches the tag; an unrelated word matches nothing", async () => {
    const tagged = await client(api).call<{ channels: { slug: string }[] }>("GET", "/api/search?q=%23study");
    expect(tagged.body.channels.map((c) => c.slug)).toContain(slugOf(liveTag));
    const none = await client(api).call<{ channels: { slug: string }[] }>("GET", "/api/search?q=zzqxv");
    expect(none.body.channels).toEqual([]);
  });

  test("gaming lists only B", async () => {
    const [cat] = await owner().select().from(schema.categories).where(eq(schema.categories.id, gaming));
    const r = await recentlyLive(cat?.slug ?? "");
    expect(r.body.map((c) => c.channel.slug)).toEqual([slugOf(streamerB)]);
  });
});

describe("F10: reserved usernames", () => {
  const signUp = async (username: string) =>
    client(api).call<{ code?: string; message?: string }>("POST", "/api/auth/sign-up/email", {
      email: `${uniqueName()}@test.invalid`,
      password: `pw-${crypto.randomUUID()}`,
      name: username,
      username,
      birthDate: "1990-01-01",
      altcha: await solveAltcha(api),
    });

  test("marketing names are refused at sign-up, whatever the case, with a clear error", async () => {
    for (const username of ["creators", "Fees", "FAQ", "join", "pricing", "studio"]) {
      const r = await signUp(username);
      expect(r.status, username).toBe(400);
      expect(r.body.code).toBe("INVALID_USERNAME");
      expect(r.body.message).toMatch(/reserved/i);
      const rows = await owner()
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.username, username.toLowerCase()));
      expect(rows).toHaveLength(0);
    }
  });

  test("a bot cannot take one either", async () => {
    const owner1 = await signUpAndSignIn(api);
    const r = await owner1.client.call<{ message?: string }>("POST", "/api/me/bots", {
      username: "inbox",
      displayName: "Inbox",
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/reserved/i);
  });

  test("a username cannot be renamed into one", async () => {
    const a = await signUpAndSignIn(api);
    const r = await a.client.call("POST", "/api/auth/update-user", { username: "guidelines" });
    expect(r.status).toBe(400);
    const [u] = await owner().select().from(schema.users).where(eq(schema.users.id, a.userId));
    expect(u?.username).toBe(a.username);
  });
});

describe("F11: the verification link's callback", () => {
  async function signUpWith(callbackURL: string | undefined) {
    const username = uniqueName();
    const email = `${username}@test.invalid`;
    const r = await client(api).call("POST", "/api/auth/sign-up/email", {
      email,
      password: `pw-${crypto.randomUUID()}`,
      name: username,
      username,
      birthDate: "1990-01-01",
      altcha: await solveAltcha(api),
      ...(callbackURL === undefined ? {} : { callbackURL }),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const mail = await waitFor(() => mailTo(email));
    const link = /https?:\/\/\S+verify-email\?token=\S+/.exec(mail.text)?.[0];
    if (!link) throw new Error("no verification link");
    return new URL(link);
  }

  test("the link carries the redirect the sign-up gave, and verifying lands there", async () => {
    const link = await signUpWith("/coop/membership?from=signup");
    expect(link.searchParams.get("callbackURL")).toBe("/coop/membership?from=signup");
    const res = await fetch(link, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/coop/membership?from=signup");
  });

  test("without one it is the front page, not the studio", async () => {
    const link = await signUpWith(undefined);
    expect(link.searchParams.get("callbackURL")).toBe("/");
  });

  test("an absolute callback on this instance becomes its path", async () => {
    const link = await signUpWith(`${api.deps.site.publicUrl}/streamer1`);
    expect(link.searchParams.get("callbackURL")).toBe("/streamer1");
  });
});
