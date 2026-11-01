// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Watch rooms (ADR 0017, decision (q)): create, invite, join, leave, close and mine against real
 * Postgres and Valkey. The refusal matrix runs through the service with database-made people (each
 * refusal is a distinct code), the HTTP wiring through signed-in sessions, and the 0046 trigger is
 * checked by direct inserts as the app role (mixed ages, unknown age, a 9th member).
 */
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BUS, RoomControlMessage } from "@commonair/contracts";
import { schema, uuidv7 } from "@commonair/db";
import { verifyChatToken } from "@commonair/tokens";
import type { Caller } from "../src/lib/access.ts";
import { watchRoomEvidence } from "../src/watch-rooms/evidence.ts";
import { triggerRefusal } from "../src/watch-rooms/rules.ts";
import { closeRoom, createRoom, getRoom, joinRoom, leaveRoom, myRooms, newInvite } from "../src/watch-rooms/service.ts";
import { signUpAndSignIn, startApi, subscriber, uniqueName, waitFor, type TestApi } from "./harness.ts";

let api: TestApi;
const sub = subscriber();
const control: RoomControlMessage[] = [];

beforeAll(async () => {
  api = await startApi();
  await sub.subscribe(BUS.roomControl);
  sub.on("message", (_ch: string, raw: string) => {
    const parsed = RoomControlMessage.safeParse(JSON.parse(raw));
    if (parsed.success) control.push(parsed.data);
  });
}, 120_000);
afterAll(async () => {
  await sub.quit();
  await api?.stop();
});

const db = () => api.db.db;
const ADULT = "1990-05-05";
const MINOR = "2012-03-04";

interface Person {
  id: string;
  username: string;
  caller: Caller;
}

async function person(
  over: Partial<typeof schema.users.$inferInsert> & { birthDate?: string | null } = {},
): Promise<Person> {
  const username = uniqueName("wr");
  const [u] = await db()
    .insert(schema.users)
    .values({
      name: `Name ${username}`,
      email: `${username}@example.test`,
      username,
      emailVerified: true,
      birthDate: ADULT,
      ...over,
    })
    .returning({ id: schema.users.id });
  const id = u!.id;
  return {
    id,
    username,
    caller: {
      kind: "session",
      sessionId: uuidv7(),
      user: { id, username, role: "user", accountType: "human", suspended: false },
    },
  };
}

interface Live {
  channelId: string;
  slug: string;
  broadcastId: string;
  owner: Person;
}

async function liveChannel(opts: { mature?: boolean; categoryMature?: boolean } = {}): Promise<Live> {
  const owner = await person();
  let categoryId: string | null = null;
  if (opts.categoryMature) {
    const [cat] = await db()
      .insert(schema.categories)
      .values({ slug: uniqueName("cat"), name: "Mature category", mature: true })
      .returning({ id: schema.categories.id });
    categoryId = cat!.id;
  }
  const [c] = await db()
    .insert(schema.channels)
    .values({
      ownerId: owner.id,
      slug: owner.username,
      displayName: owner.username,
      mature: opts.mature ?? false,
      categoryId,
    })
    .returning({ id: schema.channels.id });
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({ channelId: c!.id, ingestProtocol: "rtmp", path: `live/${owner.username}` })
    .returning({ id: schema.broadcasts.id });
  await db().update(schema.channels).set({ liveBroadcastId: b!.id }).where(eq(schema.channels.id, c!.id));
  return { channelId: c!.id, slug: owner.username, broadcastId: b!.id, owner };
}

/** The refusal code a call failed with (`PRECONDITION_FAILED`'s `requirement`). */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const data = (err as { data?: { requirement?: string } }).data;
    if (data?.requirement) return data.requirement;
    return `error:${(err as { code?: string }).code ?? String(err)}`;
  }
  return "accepted";
}

const deps = () => api.deps;

describe("create", () => {
  test("an adult opens an adult room on a live broadcast and is its first member", async () => {
    const ch = await liveChannel();
    const host = await person();
    const room = await createRoom(deps(), host.caller, ch.slug);
    expect(room).toMatchObject({
      ageBand: "adult",
      mature: false,
      broadcastId: ch.broadcastId,
      channel: { id: ch.channelId, slug: ch.slug },
      host: { id: host.id },
      endedAt: null,
      chatAudience: `room:${room.id}`,
    });
    expect(room.members.map((m) => [m.user.id, m.host])).toEqual([[host.id, true]]);
    expect(room.invite.nonce.length).toBeGreaterThanOrEqual(16);
    const url = new URL(room.invite.url);
    expect(url.pathname).toBe(`/${ch.slug}`);
    expect(url.searchParams.get("room")).toBe(room.id);
    expect(url.searchParams.get("invite")).toBe(room.invite.nonce);
    // Stored as its hash only.
    const [row] = await db().select().from(schema.watchRooms).where(eq(schema.watchRooms.id, room.id));
    expect(row!.inviteHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.inviteHash).not.toContain(room.invite.nonce);
  });

  test("a minor opens a minor room", async () => {
    const ch = await liveChannel();
    const host = await person({ birthDate: MINOR });
    const room = await createRoom(deps(), host.caller, ch.slug);
    expect(room.ageBand).toBe("minor");
  });

  test("a new room ends the host's previous one", async () => {
    const ch = await liveChannel();
    const host = await person();
    const first = await createRoom(deps(), host.caller, ch.slug);
    const second = await createRoom(deps(), host.caller, ch.slug);
    const [row] = await db().select().from(schema.watchRooms).where(eq(schema.watchRooms.id, first.id));
    expect(row).toMatchObject({ endReason: "host_left", inviteHash: null });
    expect((await myRooms(deps(), host.caller)).map((r) => r.id)).toEqual([second.id]);
  });

  test.each([
    ["null birth date", { birthDate: null }, {}, "room_birth_date_unknown"],
    ["future birth date", { birthDate: "2099-01-01" }, {}, "room_birth_date_unknown"],
    ["a minor on a mature channel", { birthDate: MINOR }, { mature: true }, "room_mature_minor"],
    ["a minor in a mature category", { birthDate: MINOR }, { categoryMature: true }, "room_mature_minor"],
    ["an adult without mature confirmation", {}, { mature: true }, "room_mature_unconfirmed"],
    ["a platform ban", { banned: true }, {}, "room_banned"],
    ["a suspension", { banned: true, banExpires: new Date(Date.now() + 86_400_000) }, {}, "room_suspended"],
  ] as const)("refused: %s", async (_name, over, chOpts, code) => {
    const ch = await liveChannel(chOpts);
    const host = await person(over);
    expect(await refusal(createRoom(deps(), host.caller, ch.slug))).toBe(code);
  });

  test("an adult who confirmed mature viewing opens an adult room on mature content", async () => {
    const ch = await liveChannel({ mature: true });
    const host = await person({ matureConfirmedAt: new Date() });
    const room = await createRoom(deps(), host.caller, ch.slug);
    expect(room).toMatchObject({ ageBand: "adult", mature: true });
  });

  test("refused: a channel ban, an ended broadcast, a rehearsal broadcast", async () => {
    const banned = await liveChannel();
    const host = await person();
    await db().insert(schema.chatBans).values({ channelId: banned.channelId, userId: host.id });
    expect(await refusal(createRoom(deps(), host.caller, banned.slug))).toBe("room_banned");

    const ended = await liveChannel();
    await db()
      .update(schema.broadcasts)
      .set({ endedAt: new Date() })
      .where(eq(schema.broadcasts.id, ended.broadcastId));
    expect(await refusal(createRoom(deps(), host.caller, ended.slug))).toBe("room_not_live");

    const rehearsal = await person();
    const [c] = await db()
      .insert(schema.channels)
      .values({ ownerId: rehearsal.id, slug: rehearsal.username, displayName: rehearsal.username })
      .returning({ id: schema.channels.id });
    await db()
      .insert(schema.broadcasts)
      .values({ channelId: c!.id, ingestProtocol: "rtmp", path: `live/${rehearsal.username}`, kind: "rehearsal" });
    expect(await refusal(createRoom(deps(), host.caller, rehearsal.username))).toBe("room_not_live");
  });

  test("an expired channel timeout does not refuse", async () => {
    const ch = await liveChannel();
    const host = await person();
    await db()
      .insert(schema.chatBans)
      .values({ channelId: ch.channelId, userId: host.id, expiresAt: new Date(Date.now() - 60_000) });
    expect((await createRoom(deps(), host.caller, ch.slug)).ageBand).toBe("adult");
  });
});

describe("join", () => {
  test("the invite admits a matching member and returns a room chat token", async () => {
    const ch = await liveChannel();
    const host = await person();
    const room = await createRoom(deps(), host.caller, ch.slug);
    const guest = await person();
    const joined = await joinRoom(deps(), guest.caller, room.id, room.invite.nonce);
    expect(joined.room.members.map((m) => m.user.id)).toEqual([host.id, guest.id]);
    expect(joined.chatUrl).toBe(api.deps.env.CHAT_PUBLIC_URL);
    const claims = await verifyChatToken(api.internalSecret, joined.chatToken);
    expect(claims).toMatchObject({ uid: guest.id, app: null, scopes: [`room:${room.id}`] });
    // A member joining again gets a fresh token, even with a stale nonce.
    await newInvite(deps(), host.caller, room.id);
    const again = await joinRoom(deps(), guest.caller, room.id, room.invite.nonce);
    expect(again.room.members).toHaveLength(2);
    expect((await getRoom(deps(), guest.caller, room.id)).id).toBe(room.id);
  });

  test("a wrong or replaced nonce is refused; a replaced invite admits with the new nonce", async () => {
    const ch = await liveChannel();
    const host = await person();
    const room = await createRoom(deps(), host.caller, ch.slug);
    const guest = await person();
    expect(await refusal(joinRoom(deps(), guest.caller, room.id, "x".repeat(32)))).toBe("room_invite_invalid");
    expect(await refusal(joinRoom(deps(), guest.caller, uuidv7(), room.invite.nonce))).toBe("room_invite_invalid");
    const fresh = await newInvite(deps(), host.caller, room.id);
    expect(await refusal(joinRoom(deps(), guest.caller, room.id, room.invite.nonce))).toBe("room_invite_invalid");
    await joinRoom(deps(), guest.caller, room.id, fresh.nonce);
    // Only the host may replace the invite.
    expect(await refusal(newInvite(deps(), guest.caller, room.id))).toBe("error:NOT_FOUND");
  });

  test.each([
    ["a minor into an adult room", ADULT, { birthDate: MINOR }, {}, "room_age_band"],
    ["an adult into a minor room", MINOR, { birthDate: ADULT }, {}, "room_age_band"],
    ["a null birth date", ADULT, { birthDate: null }, {}, "room_birth_date_unknown"],
    ["a platform ban", ADULT, { banned: true }, {}, "room_banned"],
    ["a suspension", ADULT, { banned: true, banExpires: new Date(Date.now() + 86_400_000) }, {}, "room_suspended"],
  ] as const)("refused: %s", async (_name, hostBirth, over, chOpts, code) => {
    const ch = await liveChannel(chOpts);
    const host = await person({ birthDate: hostBirth });
    const room = await createRoom(deps(), host.caller, ch.slug);
    const guest = await person(over);
    expect(await refusal(joinRoom(deps(), guest.caller, room.id, room.invite.nonce))).toBe(code);
  });

  test("mature content: an unconfirmed adult is refused, a confirmed one admitted", async () => {
    const ch = await liveChannel({ mature: true });
    const host = await person({ matureConfirmedAt: new Date() });
    const room = await createRoom(deps(), host.caller, ch.slug);
    const unconfirmed = await person();
    expect(await refusal(joinRoom(deps(), unconfirmed.caller, room.id, room.invite.nonce))).toBe(
      "room_mature_unconfirmed",
    );
    const confirmed = await person({ matureConfirmedAt: new Date() });
    await joinRoom(deps(), confirmed.caller, room.id, room.invite.nonce);
  });

  test("a minor cannot join a room on a mature channel", async () => {
    const ch = await liveChannel({ mature: true });
    const host = await person({ matureConfirmedAt: new Date() });
    const room = await createRoom(deps(), host.caller, ch.slug);
    const minor = await person({ birthDate: MINOR });
    expect(await refusal(joinRoom(deps(), minor.caller, room.id, room.invite.nonce))).toBe("room_mature_minor");
  });

  test("a channel ban on the host channel is refused", async () => {
    const ch = await liveChannel();
    const host = await person();
    const room = await createRoom(deps(), host.caller, ch.slug);
    const guest = await person();
    await db().insert(schema.chatBans).values({ channelId: ch.channelId, userId: guest.id });
    expect(await refusal(joinRoom(deps(), guest.caller, room.id, room.invite.nonce))).toBe("room_banned");
  });

  test("a block in either direction with any member is refused", async () => {
    const ch = await liveChannel();
    const host = await person();
    const room = await createRoom(deps(), host.caller, ch.slug);
    const member = await person();
    await joinRoom(deps(), member.caller, room.id, room.invite.nonce);

    const blocker = await person();
    await db().insert(schema.userBlocks).values({ userId: blocker.id, blockedUserId: member.id });
    expect(await refusal(joinRoom(deps(), blocker.caller, room.id, room.invite.nonce))).toBe("room_blocked");

    const blocked = await person();
    await db().insert(schema.userBlocks).values({ userId: host.id, blockedUserId: blocked.id });
    expect(await refusal(joinRoom(deps(), blocked.caller, room.id, room.invite.nonce))).toBe("room_blocked");
  });

  test("a full room refuses the 9th member", async () => {
    const ch = await liveChannel();
    const host = await person();
    const room = await createRoom(deps(), host.caller, ch.slug);
    for (let i = 0; i < 7; i++) await joinRoom(deps(), (await person()).caller, room.id, room.invite.nonce);
    const ninth = await person();
    expect(await refusal(joinRoom(deps(), ninth.caller, room.id, room.invite.nonce))).toBe("room_full");
  });

  test("a room whose broadcast ended is ended at join and refused", async () => {
    const ch = await liveChannel();
    const host = await person();
    const room = await createRoom(deps(), host.caller, ch.slug);
    await db().update(schema.broadcasts).set({ endedAt: new Date() }).where(eq(schema.broadcasts.id, ch.broadcastId));
    await db().update(schema.channels).set({ liveBroadcastId: null }).where(eq(schema.channels.id, ch.channelId));
    const guest = await person();
    expect(await refusal(joinRoom(deps(), guest.caller, room.id, room.invite.nonce))).toBe("room_closed");
    const [row] = await db().select().from(schema.watchRooms).where(eq(schema.watchRooms.id, room.id));
    expect(row).toMatchObject({ endReason: "broadcast_ended", inviteHash: null });
    await waitFor(async () => control.find((m) => m.roomId === room.id && m.op === "room.close") ?? null);
  });

  test("a band change between joins removes the member at their next join", async () => {
    const ch = await liveChannel();
    // Turns 18 tomorrow: a minor today.
    const now = new Date();
    const eighteenTomorrow = new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate() + 1));
    const birthDate = eighteenTomorrow.toISOString().slice(0, 10);
    const host = await person({ birthDate: MINOR });
    const room = await createRoom(deps(), host.caller, ch.slug);
    const member = await person({ birthDate });
    await joinRoom(deps(), member.caller, room.id, room.invite.nonce);
    // A day later (the API's clock), the member is an adult: removed and kicked.
    const later = { ...deps(), now: () => new Date(Date.now() + 86_400_000 + 60_000) };
    expect(await refusal(joinRoom(later, member.caller, room.id, room.invite.nonce))).toBe("room_age_band");
    const open = await db()
      .select()
      .from(schema.watchRoomMembers)
      .where(
        and(
          eq(schema.watchRoomMembers.roomId, room.id),
          eq(schema.watchRoomMembers.userId, member.id),
          isNull(schema.watchRoomMembers.leftAt),
        ),
      );
    expect(open).toEqual([]);
    await waitFor(
      async () =>
        control.find(
          (m) => m.op === "room.kick" && m.roomId === room.id && m.userId === member.id && m.reason === "age_band",
        ) ?? null,
    );
  });
});

describe("leave, close and mine", () => {
  test("a member leaves; the host leaving ends the room", async () => {
    const ch = await liveChannel();
    const host = await person();
    const room = await createRoom(deps(), host.caller, ch.slug);
    const guest = await person();
    await joinRoom(deps(), guest.caller, room.id, room.invite.nonce);
    expect((await myRooms(deps(), guest.caller)).map((r) => r.id)).toEqual([room.id]);
    await leaveRoom(deps(), guest.caller, room.id);
    expect(await myRooms(deps(), guest.caller)).toEqual([]);
    await waitFor(async () => control.find((m) => m.op === "room.kick" && m.userId === guest.id) ?? null);
    await leaveRoom(deps(), host.caller, room.id);
    const [row] = await db().select().from(schema.watchRooms).where(eq(schema.watchRooms.id, room.id));
    expect(row).toMatchObject({ endReason: "host_left", inviteHash: null });
    expect(row!.endedAt).not.toBeNull();
  });

  test("only the host closes; a closed room takes no one", async () => {
    const ch = await liveChannel();
    const host = await person();
    const room = await createRoom(deps(), host.caller, ch.slug);
    const guest = await person();
    await joinRoom(deps(), guest.caller, room.id, room.invite.nonce);
    expect(await refusal(closeRoom(deps(), guest.caller, room.id))).toBe("error:FORBIDDEN");
    expect(await refusal(closeRoom(deps(), (await person()).caller, room.id))).toBe("error:NOT_FOUND");
    await closeRoom(deps(), host.caller, room.id);
    await waitFor(async () => control.find((m) => m.op === "room.close" && m.roomId === room.id) ?? null);
    const late = await person();
    expect(await refusal(joinRoom(deps(), late.caller, room.id, room.invite.nonce))).toBe("room_closed");
    const left = await db()
      .select()
      .from(schema.watchRoomMembers)
      .where(and(eq(schema.watchRoomMembers.roomId, room.id), isNull(schema.watchRoomMembers.leftAt)));
    expect(left).toEqual([]);
    expect(await refusal(getRoom(deps(), guest.caller, room.id))).toBe("error:NOT_FOUND");
  });
});

describe("the 0046 trigger (direct inserts as the app role)", () => {
  /** The trigger's refusal code for a direct insert, or "accepted". */
  async function direct(roomId: string, userId: string): Promise<string> {
    try {
      await db().insert(schema.watchRoomMembers).values({ roomId, userId });
      return "accepted";
    } catch (err) {
      return triggerRefusal(err, null) ?? `error:${String(err)}`;
    }
  }

  test("a mixed-age member, an unknown age and a 9th member are refused", async () => {
    const ch = await liveChannel();
    const host = await person();
    const room = await createRoom(deps(), host.caller, ch.slug);
    expect(await direct(room.id, (await person({ birthDate: MINOR })).id)).toBe("room_age_band");
    expect(await direct(room.id, (await person({ birthDate: null })).id)).toBe("room_birth_date_unknown");
    for (let i = 0; i < 7; i++) expect(await direct(room.id, (await person()).id)).toBe("accepted");
    expect(await direct(room.id, (await person()).id)).toBe("room_full");
  });

  test("a minor on a mature room and a member of an ended room are refused", async () => {
    const ch = await liveChannel({ mature: true });
    const host = await person({ matureConfirmedAt: new Date() });
    const room = await createRoom(deps(), host.caller, ch.slug);
    expect(await direct(room.id, (await person()).id)).toBe("room_mature_minor");
    await closeRoom(deps(), host.caller, room.id);
    expect(await direct(room.id, (await person({ matureConfirmedAt: new Date() })).id)).toBe("room_closed");
  });
});

describe("HTTP", () => {
  test("create, join refusal codes and evidence through a report", async () => {
    const ch = await liveChannel();
    const [host, guest, minor] = await Promise.all([
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api, { birthDate: MINOR }),
    ]);
    const created = await host.client.call<{ id: string; invite: { nonce: string } }>(
      "POST",
      `/api/channels/${ch.slug}/watch-rooms`,
    );
    expect(created.status).toBe(200);
    const roomId = created.body.id;
    const nonce = created.body.invite.nonce;
    const refused = await minor.client.call<{ data?: { requirement?: string } }>(
      "POST",
      `/api/watch-rooms/${roomId}/join`,
      { nonce },
    );
    expect(refused.status).toBe(412);
    expect(refused.body.data?.requirement).toBe("room_age_band");
    const joined = await guest.client.call<{ chatToken: string }>("POST", `/api/watch-rooms/${roomId}/join`, {
      nonce,
    });
    expect(joined.status).toBe(200);
    const mine = await guest.client.call<{ id: string }[]>("GET", "/api/me/watch-rooms");
    expect(mine.body.map((r) => r.id)).toEqual([roomId]);

    await db()
      .insert(schema.watchRoomMessages)
      .values([
        { roomId, authorId: host.userId, body: "hello room", createdAt: new Date(Date.now() - 1000) },
        { roomId, authorId: guest.userId, body: "hi", createdAt: new Date() },
      ]);
    const report = await guest.client.call<{ id: string }>("POST", "/api/reports", {
      subjectType: "watch_room",
      subjectId: roomId,
      reason: "harassment",
    });
    expect(report.status).toBe(200);
    const [row] = await db().select().from(schema.reports).where(eq(schema.reports.id, report.body.id));
    expect(row!.channelId).toBeNull();
    const ev = row!.evidence as { messages: { userId: string; body: string }[]; members: { userId: string }[] };
    expect(ev.messages.map((m) => [m.userId, m.body])).toEqual([
      [host.userId, "hello room"],
      [guest.userId, "hi"],
    ]);
    expect(ev.members.map((m) => m.userId)).toEqual([host.userId, guest.userId]);
    // Ids only: no usernames or emails in the copy.
    expect(JSON.stringify(ev)).not.toContain(host.username);
    expect(JSON.stringify(ev)).not.toContain(guest.email);
  });
});

describe("evidence", () => {
  test("copies messages and members; null for an unknown room", async () => {
    expect(await watchRoomEvidence(db(), uuidv7())).toBeNull();
    const ch = await liveChannel();
    const host = await person();
    const room = await createRoom(deps(), host.caller, ch.slug);
    const guest = await person();
    await joinRoom(deps(), guest.caller, room.id, room.invite.nonce);
    await leaveRoom(deps(), guest.caller, room.id);
    await db().insert(schema.watchRoomMessages).values({ roomId: room.id, authorId: guest.id, body: "bye" });
    const got = await watchRoomEvidence(db(), room.id);
    expect(got?.evidence).toMatchObject({
      v: 1,
      roomId: room.id,
      hostId: host.id,
      ageBand: "adult",
      truncated: false,
      messages: [{ userId: guest.id, body: "bye" }],
    });
    const members = (got!.evidence as { members: { userId: string; leftAt: string | null; host: boolean }[] }).members;
    expect(members.map((m) => [m.userId, m.host, m.leftAt !== null])).toEqual([
      [host.id, true, false],
      [guest.id, false, true],
    ]);
  });
});
