// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `planBulkTimeout` (J5-d): who a wave's bulk timeout reaches, and why the rest are skipped. */
import { describe, expect, test } from "vite-plus/test";
import { planBulkTimeout, type BulkFacts, type WaveMessage } from "../src/chat-bulk/plan.ts";

const CH = "ch";
const NOW = new Date("2026-11-11T12:00:00Z");
const END = new Date(NOW.getTime() + 600_000);

let seq = 0;
const msg = (userId: string, over: Partial<WaveMessage> = {}): WaveMessage => ({
  id: `m${++seq}`,
  userId,
  channelId: CH,
  deleted: false,
  ...over,
});

const facts = (messages: WaveMessage[], over: Partial<BulkFacts> = {}): BulkFacts => ({
  channelId: CH,
  ownerId: "owner",
  callerId: "mod",
  messages,
  staff: new Set(),
  channelMods: new Set(),
  activeBans: new Map(),
  expiresAt: END,
  ...over,
});

describe("planBulkTimeout", () => {
  test("dedupes senders in first-seen order and deletes every live message", () => {
    const ms = [msg("a"), msg("b"), msg("a"), msg("c")];
    const plan = planBulkTimeout(facts(ms));
    expect(plan.targets).toEqual(["a", "b", "c"]);
    expect(plan.skipped).toEqual([]);
    expect(plan.deletable).toEqual(ms.map((m) => m.id));
  });

  test("an empty wave plans nothing", () => {
    expect(planBulkTimeout(facts([]))).toEqual({ targets: [], skipped: [], deletable: [] });
  });

  test("skips the owner, staff, channel moderators and the caller, and keeps their messages", () => {
    const ms = [msg("owner"), msg("admin"), msg("editor"), msg("mod"), msg("x")];
    const plan = planBulkTimeout(facts(ms, { staff: new Set(["admin"]), channelMods: new Set(["editor"]) }));
    expect(plan.targets).toEqual(["x"]);
    expect(plan.skipped).toEqual([
      { userId: "owner", reason: "owner" },
      { userId: "admin", reason: "staff" },
      { userId: "editor", reason: "moderator" },
      { userId: "mod", reason: "moderator" },
    ]);
    expect(plan.deletable).toEqual([ms[4]?.id]);
  });

  test("the owner as caller is skipped as the owner; staff outranks a channel role", () => {
    const plan = planBulkTimeout(
      facts([msg("owner"), msg("both")], {
        callerId: "owner",
        staff: new Set(["both"]),
        channelMods: new Set(["both"]),
      }),
    );
    expect(plan.skipped).toEqual([
      { userId: "owner", reason: "owner" },
      { userId: "both", reason: "staff" },
    ]);
  });

  test("a ban or a longer (or equal) timeout is never shortened; a shorter timeout is extended", () => {
    const plan = planBulkTimeout(
      facts([msg("banned"), msg("longer"), msg("equal"), msg("shorter")], {
        activeBans: new Map<string, Date | null>([
          ["banned", null],
          ["longer", new Date(END.getTime() + 1)],
          ["equal", END],
          ["shorter", new Date(END.getTime() - 1)],
        ]),
      }),
    );
    expect(plan.targets).toEqual(["shorter"]);
    expect(plan.skipped.map((s) => [s.userId, s.reason])).toEqual([
      ["banned", "already_banned"],
      ["longer", "already_banned"],
      ["equal", "already_banned"],
    ]);
    // A banned sender's messages can still go: only people a moderator may not act on keep theirs.
    expect(plan.deletable).toHaveLength(4);
  });

  test("a sender seen only in another channel is not_in_channel and nothing of theirs is deleted", () => {
    const foreign = msg("f", { channelId: "other" });
    const plan = planBulkTimeout(facts([foreign, msg("x")]));
    expect(plan.targets).toEqual(["x"]);
    expect(plan.skipped).toEqual([{ userId: "f", reason: "not_in_channel" }]);
    expect(plan.deletable).not.toContain(foreign.id);
  });

  test("a sender with a message here and one elsewhere is a target; only the local one is deleted", () => {
    const foreign = msg("x", { channelId: "other" });
    const local = msg("x");
    const plan = planBulkTimeout(facts([foreign, local]));
    expect(plan.targets).toEqual(["x"]);
    expect(plan.skipped).toEqual([]);
    expect(plan.deletable).toEqual([local.id]);
  });

  test("a deleted message still names its sender but is not deleted again", () => {
    const gone = msg("x", { deleted: true });
    const plan = planBulkTimeout(facts([gone]));
    expect(plan.targets).toEqual(["x"]);
    expect(plan.deletable).toEqual([]);
  });

  test("a repeated message id is deleted once", () => {
    const m = msg("x");
    expect(planBulkTimeout(facts([m, m])).deletable).toEqual([m.id]);
  });
});
