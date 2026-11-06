// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The watch-room run's shared state and its `via=api` paths, through the real runner against a
 * stand-in platform (no stack in the unit tests): channels start once and on first use, `release`
 * stops what was opened, `createRoom` / `joinRoom` read the invite and the refusal codes, and the
 * refusal steps (4–6) judge the codes the API answers. The stand-in API refuses as the watch-room
 * rules say (ADR 0017): an age-band mismatch, a minor on a mature channel, a channel ban, a block
 * in either direction. Steps 1–3, 7 and 8 need browsers or the database (the harness scenario).
 */
import { createLogger } from "@commonair/observability";
import { describe, expect, test } from "vite-plus/test";
import { loadHarnessEnv } from "../../src/env.ts";
import type { Platform } from "../../src/platform.ts";
import { runOne } from "../../src/runner.ts";
import { type ScenarioContext, type ScenarioResult, defineScenario } from "../../src/scenario.ts";
import type { SignedInUser } from "../../src/users.ts";
import {
  MINOR_BIRTH_DATE,
  WATCH_ROOM_STEP_RUNNERS,
  type WatchRoomRun,
  createRoom,
  joinRoom,
  newWatchRoomRun,
} from "../../src/w3/watch-rooms/index.ts";

const env = loadHarnessEnv({});
const log = createLogger({ service: "harness-test", level: "fatal", write: () => undefined });

const refuse = (requirement: string) => Object.assign(new Error(requirement), { data: { requirement } });

interface Room {
  id: string;
  channel: string;
  members: Set<string>;
  minor: boolean;
  mature: boolean;
}

/** A small model of the watch-room rules, enough for the refusal steps. */
function world(o: { breakJoins?: boolean } = {}) {
  const users = new Map<string, { minor: boolean; blocks: Set<string>; confirmedMature: boolean }>();
  const bans = new Map<string, Set<string>>();
  const mature = new Set<string>();
  const rooms = new Map<string, Room>();
  const calls: string[] = [];
  let n = 0;
  const encoders = { started: 0, stopped: 0 };

  const blocked = (a: string, b: string) => users.get(a)?.blocks.has(b) || users.get(b)?.blocks.has(a);
  const nameOf = new Map<string, string>();

  const signUp = async (opts: { prefix: string; birthDate?: string }): Promise<SignedInUser> => {
    const id = `u${n++}`;
    const username = `${opts.prefix}_${id}`;
    nameOf.set(username, id);
    users.set(id, { minor: opts.birthDate === MINOR_BIRTH_DATE, blocks: new Set(), confirmedMature: false });
    calls.push(`signUp ${opts.prefix}`);
    const me = users.get(id) as { minor: boolean; blocks: Set<string>; confirmedMature: boolean };
    const client = {
      channels: {
        update: async (i: { channel: string; mature?: boolean }) => {
          if (i.mature) mature.add(i.channel);
          return {};
        },
      },
      me: {
        confirmMature: async () => void (me.confirmedMature = true),
        blocks: { add: async (i: { username: string }) => void me.blocks.add(nameOf.get(i.username) ?? "") },
      },
      chat: {
        bans: {
          ban: async (i: { channel: string; username: string }) => {
            bans.set(i.channel, (bans.get(i.channel) ?? new Set()).add(nameOf.get(i.username) ?? ""));
            return {};
          },
        },
      },
      watchRooms: {
        create: async (i: { channel: string }) => {
          if (me.minor && mature.has(i.channel)) throw refuse("room_mature_minor");
          const roomId = `room${rooms.size}`;
          rooms.set(roomId, {
            id: roomId,
            channel: i.channel,
            members: new Set([id]),
            minor: me.minor,
            mature: mature.has(i.channel),
          });
          const nonce = `nonce-${roomId}`;
          return {
            id: roomId,
            ageBand: me.minor ? "minor" : "adult",
            mature: mature.has(i.channel),
            invite: { url: `http://web.test/${i.channel}?room=${roomId}&invite=${nonce}`, nonce },
          };
        },
        join: async (i: { id: string; nonce: string }) => {
          calls.push(`join ${i.id}`);
          const room = rooms.get(i.id);
          if (!room || i.nonce !== `nonce-${room.id}`) throw refuse("room_invite");
          if (o.breakJoins) throw new Error("socket hang up");
          // The mature rule comes first: a minor on a mature channel hears that, not the age band.
          if (room.mature && me.minor) throw refuse("room_mature_minor");
          if (room.minor !== me.minor) throw refuse("room_age_band");
          if (bans.get(room.channel)?.has(id)) throw refuse("room_banned");
          if ([...room.members].some((m) => blocked(m, id))) throw refuse("room_blocked");
          room.members.add(id);
          return {};
        },
      },
    };
    return {
      id,
      username,
      email: `${username}@example.test`,
      me: { channelSlug: `${username}-ch` },
      api: { client },
    } as unknown as SignedInUser;
  };

  const platform = {
    probe: async () => null,
    signUp,
    streamerFor: async () => ({
      start: async () => void encoders.started++,
      stop: async () => void encoders.stopped++,
    }),
    waitForLive: async () => undefined,
  } as unknown as Platform;
  return { platform, calls, encoders, rooms, mature };
}

async function inScenario(platform: Platform, body: (ctx: ScenarioContext) => Promise<void>): Promise<ScenarioResult> {
  const s = defineScenario({ name: "watch-room", description: "", needs: [], run: body });
  return runOne(s, platform, { command: "run", profile: "default", env, log, platform, runId: "r1" });
}

const failed = (r: ScenarioResult) => r.assertions.filter((a) => !a.passed).map((a) => a.name);

describe("the run's shared channels", () => {
  test("each shared channel starts once, on first use; release stops it and the next caller starts anew", async () => {
    const w = world();
    const r = await inScenario(w.platform, async (ctx) => {
      const run = await newWatchRoomRun(ctx, { via: "api" });
      const [a, b] = await Promise.all([run.plainChannel(), run.plainChannel()]);
      expect(a).toBe(b);
      const sync = await run.syncChannel();
      expect(sync.channel).not.toBe(a.channel);
      const own = await run.newChannel("wrx", { mature: true });
      expect(w.mature.has(own.channel)).toBe(true);
      expect(w.encoders.started).toBe(3);
      run.sync = { roomId: "r", members: [], samples: {} };
      expect(await run.release()).toBe(3);
      expect(w.encoders.stopped).toBe(3);
      expect(run.sync).toBeNull();
      expect(await run.release()).toBe(0);
      const again = await run.plainChannel();
      expect(again.channel).not.toBe(a.channel);
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe("passed");
  });
});

describe("createRoom and joinRoom through the API", () => {
  test("the invite's path and nonce come from the room; a refusal is its code; other errors throw", async () => {
    const w = world();
    const r = await inScenario(w.platform, async (ctx) => {
      const run: WatchRoomRun = await newWatchRoomRun(ctx, { via: "api" });
      const host = await ctx.platform.signUp({ prefix: "host" });
      const room = await createRoom(run, host, "chan");
      expect(room).toEqual({
        roomId: "room0",
        invitePath: "/chan?room=room0&invite=nonce-room0",
        nonce: "nonce-room0",
      });
      const guest = await ctx.platform.signUp({ prefix: "guest" });
      expect(await joinRoom(run, guest, room)).toBeNull();
      const minor = await ctx.platform.signUp({ prefix: "minor", birthDate: MINOR_BIRTH_DATE });
      expect(await joinRoom(run, minor, room)).toBe("room_age_band");
      expect(await joinRoom(run, guest, { ...room, nonce: "stale" })).toBe("room_invite");
    });
    expect(r.status).toBe("passed");
    const broken = world({ breakJoins: true });
    const r2 = await inScenario(broken.platform, async (ctx) => {
      const run = await newWatchRoomRun(ctx, { via: "api" });
      const host = await ctx.platform.signUp({ prefix: "host" });
      const room = await createRoom(run, host, "chan");
      await joinRoom(run, await ctx.platform.signUp({ prefix: "guest" }), room);
    });
    expect(r2.status).toBe("failed");
    expect(r2.error).toContain("socket hang up");
  });
});

describe("the refusal steps (via=api)", () => {
  const step = async (n: 4 | 5 | 6) => {
    const w = world();
    const r = await inScenario(w.platform, async (ctx) => {
      await WATCH_ROOM_STEP_RUNNERS[n](await newWatchRoomRun(ctx, { via: "api" }));
    });
    return { r, w };
  };

  test("4: a minor can neither join nor open a room on a mature channel", async () => {
    const { r } = await step(4);
    expect(r.error).toBeUndefined();
    expect(failed(r)).toEqual([]);
    expect(r.assertions.map((a) => a.name)).toEqual([
      expect.stringContaining("the room is adult and mature"),
      expect.stringContaining("refused with room_mature_minor"),
      expect.stringContaining("create refused with room_mature_minor"),
    ]);
  });

  test("5: a viewer the channel banned is refused", async () => {
    const { r } = await step(5);
    expect(failed(r)).toEqual([]);
    expect(r.assertions.map((a) => a.name)).toEqual([expect.stringContaining("refused with room_banned")]);
  });

  test("6: a block in either direction is refused", async () => {
    const { r, w } = await step(6);
    expect(failed(r)).toEqual([]);
    expect(r.assertions).toHaveLength(2);
    // Both joins were tried on the same room.
    expect(w.calls.filter((c) => c.startsWith("join"))).toEqual(["join room0", "join room0"]);
  });
});
