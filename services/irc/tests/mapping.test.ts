// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { NOTICE_CODES } from "@commonair/contracts";
import { CapNegotiator } from "../src/caps.ts";
import { CHAT_COLOR_HEX, colorTag } from "../src/colors.ts";
import { codePointIndex, emotesTag } from "../src/emotes.ts";
import { COMMAND_SUCCESS_MSG_IDS, NOTICE_MSG_IDS, noticeMsgId } from "../src/notices.ts";
import { TokenBucket } from "../src/ratelimit.ts";

/** Emote range helper: UTF-16 offsets of `code` within `body` (nth occurrence). */
function range(body: string, code: string, emoteId: string, nth = 0) {
  let idx = -1;
  for (let i = 0; i <= nth; i++) idx = body.indexOf(code, idx + 1);
  return { emoteId, code, start: idx, end: idx + code.length };
}

describe("emote offsets: UTF-16 exclusive → code points inclusive", () => {
  test("ASCII", () => {
    const body = "Kappa Keepo Kappa";
    expect(
      emotesTag(body, [range(body, "Kappa", "25"), range(body, "Keepo", "1902"), range(body, "Kappa", "25", 1)]),
    ).toBe("25:0-4,12-16/1902:6-10");
  });

  test("astral emoji before the emote shift offsets by one per emoji", () => {
    const body = "🎉🎉 Kappa";
    // "🎉🎉 " is 5 UTF-16 units but 3 code points.
    expect(emotesTag(body, [range(body, "Kappa", "25")])).toBe("25:3-7");
  });

  test("an emote code that is itself astral", () => {
    const body = "hi 🦀 x 🦀";
    expect(emotesTag(body, [range(body, "🦀", "crab"), range(body, "🦀", "crab", 1)])).toBe("crab:3-3,7-7");
  });

  test("BMP non-ASCII characters count as one", () => {
    const body = "héllo Kappa";
    expect(emotesTag(body, [range(body, "Kappa", "25")])).toBe("25:6-10");
  });

  test("ZWJ sequences count each code point (as Twitch does)", () => {
    const body = "👩‍💻 Kappa"; // woman, ZWJ, laptop = 3 code points, 5 units
    expect(emotesTag(body, [range(body, "Kappa", "25")])).toBe("25:4-8");
  });

  test("ranges are ordered by position and grouped by id in first-seen order", () => {
    const body = "B A B";
    expect(
      emotesTag(body, [
        { emoteId: "b", code: "B", start: 4, end: 5 },
        { emoteId: "a", code: "A", start: 2, end: 3 },
        { emoteId: "b", code: "B", start: 0, end: 1 },
      ]),
    ).toBe("b:0-0,4-4/a:2-2");
  });

  test("UUID ids are fine (dashes before the colon)", () => {
    const id = "0190f1c2-0000-7000-8000-000000000001";
    expect(emotesTag("x", [{ emoteId: id, code: "x", start: 0, end: 1 }])).toBe(`${id}:0-0`);
  });

  test("skips invalid ranges: out of bounds, empty, splitting a surrogate pair, unsafe ids", () => {
    const body = "🎉 ok";
    expect(
      emotesTag(body, [
        { emoteId: "oob", code: "x", start: 3, end: 99 },
        { emoteId: "empty", code: "x", start: 2, end: 2 },
        { emoteId: "split", code: "x", start: 1, end: 3 },
        { emoteId: "bad:id", code: "ok", start: 3, end: 5 },
        { emoteId: "good", code: "ok", start: 3, end: 5 },
      ]),
    ).toBe("good:2-3");
  });

  test("no emotes → empty tag", () => {
    expect(emotesTag("hello", [])).toBe("");
  });

  test("codePointIndex marks the middle of surrogate pairs", () => {
    expect(codePointIndex("a🎉b")).toEqual([0, 1, undefined, 2, 3]);
  });
});

describe("notice msg-id mapping", () => {
  test("every upstream code has a mapping", () => {
    for (const code of NOTICE_CODES) expect(NOTICE_MSG_IDS[code]).toMatch(/^[a-z_]+$/);
  });

  test.each([
    ["msg_banned", "msg_banned"],
    ["msg_slowmode", "msg_slowmode"],
    ["msg_held", "msg_rejected"],
    ["msg_rejected", "msg_rejected_mandatory"],
    ["no_permission", "no_permission"],
    ["emote_only_on", "emote_only_on"],
  ])("%s → %s", (code, msgId) => {
    expect(noticeMsgId(code)).toBe(msgId);
  });

  test("unknown codes (newer upstream) → unrecognized_cmd", () => {
    expect(noticeMsgId("msg_brand_new")).toBe("unrecognized_cmd");
  });

  test("cmd_success maps per command; commands without a Twitch success notice are dropped", () => {
    expect(noticeMsgId("cmd_success", "ban")).toBe("ban_success");
    expect(noticeMsgId("cmd_success", "timeout")).toBe("timeout_success");
    expect(noticeMsgId("cmd_success", "delete")).toBe("delete_message_success");
    expect(noticeMsgId("cmd_success", "slow")).toBeNull();
    expect(noticeMsgId("cmd_success", "")).toBeNull();
    expect(Object.keys(COMMAND_SUCCESS_MSG_IDS).sort()).toEqual(
      ["ban", "delete", "mod", "timeout", "unban", "unmod", "untimeout", "unvip", "vip"].sort(),
    );
  });
});

describe("color tokens", () => {
  test("every chat-N token maps to hex", () => {
    for (let i = 1; i <= 12; i++) expect(CHAT_COLOR_HEX[`chat-${i}`]).toMatch(/^#[0-9A-F]{6}$/);
  });
  test("hex passes through uppercased; unknown/unset → empty", () => {
    expect(colorTag("chat-1")).toBe("#FF0000");
    expect(colorTag("#a1b2c3")).toBe("#A1B2C3");
    expect(colorTag("violet")).toBe("");
    expect(colorTag(null)).toBe("");
    expect(colorTag("#fff")).toBe("");
  });
});

describe("CAP negotiation", () => {
  test("LS suspends registration until END; REQ is ACKed atomically", () => {
    const c = new CapNegotiator();
    expect(c.handle("LS", [], false)).toEqual({
      kind: "reply",
      reply: { subcommand: "LS", caps: "twitch.tv/tags twitch.tv/commands twitch.tv/membership" },
    });
    expect(c.suspended).toBe(true);
    expect(c.handle("REQ", ["twitch.tv/tags twitch.tv/commands"], false)).toEqual({
      kind: "reply",
      reply: { subcommand: "ACK", caps: "twitch.tv/tags twitch.tv/commands" },
    });
    expect(c.has("twitch.tv/tags")).toBe(true);
    expect(c.has("twitch.tv/membership")).toBe(false);
    expect(c.handle("END", [], false)).toEqual({ kind: "end" });
    expect(c.suspended).toBe(false);
  });

  test("REQ without LS does not suspend (tmi.js flow), END is then a no-op", () => {
    const c = new CapNegotiator();
    c.handle("REQ", ["twitch.tv/membership"], false);
    expect(c.suspended).toBe(false);
    expect(c.handle("END", [], false)).toEqual({ kind: "none" });
  });

  test("an unsupported cap NAKs the whole request and changes nothing", () => {
    const c = new CapNegotiator();
    expect(c.handle("REQ", ["twitch.tv/tags sasl"], false)).toEqual({
      kind: "reply",
      reply: { subcommand: "NAK", caps: "twitch.tv/tags sasl" },
    });
    expect(c.has("twitch.tv/tags")).toBe(false);
    expect(c.handle("REQ", [""], false)).toMatchObject({ reply: { subcommand: "NAK" } });
  });

  test("-cap removes a cap; LIST reports enabled caps", () => {
    const c = new CapNegotiator();
    c.handle("REQ", ["twitch.tv/tags twitch.tv/commands"], true);
    c.handle("REQ", ["-twitch.tv/tags"], true);
    expect(c.handle("LIST", [], true)).toEqual({
      kind: "reply",
      reply: { subcommand: "LIST", caps: "twitch.tv/commands" },
    });
  });

  test("LS after registration does not suspend; unknown subcommands are invalid", () => {
    const c = new CapNegotiator();
    c.handle("ls", [], true);
    expect(c.suspended).toBe(false);
    expect(c.handle("FOO", [], true)).toEqual({ kind: "invalid", subcommand: "FOO" });
  });
});

describe("TokenBucket", () => {
  test("allows a burst, then refills at the sustained rate", () => {
    let now = 0;
    const b = new TokenBucket(3, 2, () => now);
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
    now = 499;
    expect(b.take()).toBe(false);
    now = 500;
    expect(b.take()).toBe(true);
    now = 100_000;
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
  });
});
