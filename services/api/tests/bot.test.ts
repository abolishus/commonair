// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** E8-bot-api pure logic: the channel bot's username derivation and command list visibility. */
import { describe, expect, test } from "vite-plus/test";
import { usernameProblem } from "../src/auth/identity.ts";
import { builtinClash, normalizeAliases, visibleCommands } from "../src/bot/commands.ts";
import { readBotConfig } from "../src/bot/dto.ts";
import { BOT_USERNAME_DIGIT_TRIES, botUsernamePlan } from "../src/bot/username.ts";

/** A deterministic `random` cycling through `values`. */
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
};

describe("botUsernamePlan", () => {
  test("a short slug gets <slug>_bot first, then five <slug>_bot<ddd> names", () => {
    const plan = botUsernamePlan("alice", seq(0.1, 0.2, 0.3, 0.4, 0.5));
    expect(plan.derived[0]).toBe("alice_bot");
    expect(plan.derived.slice(1)).toEqual([
      "alice_bot100",
      "alice_bot200",
      "alice_bot300",
      "alice_bot400",
      "alice_bot500",
    ]);
    expect(plan.derived).toHaveLength(1 + BOT_USERNAME_DIGIT_TRIES);
  });

  test("digits are zero-padded to three", () => {
    const plan = botUsernamePlan("bob", seq(0, 0.001, 0.05, 0.999, 0.5));
    expect(plan.derived.slice(1)).toEqual(["bob_bot000", "bob_bot001", "bob_bot050", "bob_bot999", "bob_bot500"]);
  });

  test("long slugs are cut so every name fits 25 characters", () => {
    const slug = "a".repeat(25);
    const plan = botUsernamePlan(slug, seq(0.1, 0.2, 0.3, 0.4, 0.5));
    expect(plan.derived[0]).toBe(`${"a".repeat(21)}_bot`);
    expect(plan.derived[1]).toBe(`${"a".repeat(18)}_bot100`);
    for (const name of [...plan.derived, plan.fallback]) {
      expect(name.length).toBeLessThanOrEqual(25);
      expect(usernameProblem(name)).toBeNull();
    }
  });

  test("a 21-character slug keeps its whole name in the first try", () => {
    const slug = "b".repeat(21);
    expect(botUsernamePlan(slug).derived[0]).toBe(`${slug}_bot`);
    expect(botUsernamePlan("c".repeat(22)).derived[0]).toBe(`${"c".repeat(21)}_bot`);
  });

  test("repeated random values do not produce duplicate names", () => {
    const plan = botUsernamePlan("carol", seq(0.1, 0.1, 0.2, 0.2, 0.3, 0.4, 0.5));
    expect(new Set(plan.derived).size).toBe(plan.derived.length);
    expect(plan.derived).toHaveLength(1 + BOT_USERNAME_DIGIT_TRIES);
  });

  test("a constant random still terminates", () => {
    const plan = botUsernamePlan("dave", () => 0.42);
    expect(plan.derived).toEqual(["dave_bot", "dave_bot420"]);
  });

  test("the fallback is channelbot_ and six hex digits", () => {
    // A reserved slug spends no random values on derived names, so the hex uses these six.
    expect(botUsernamePlan("mod_erin", seq(0, 0.5, 0.99, 0.1, 0.2, 0.3)).fallback).toBe("channelbot_08f134");
    expect(botUsernamePlan("erin").fallback).toMatch(/^channelbot_[0-9a-f]{6}$/);
    expect(usernameProblem(botUsernamePlan("erin").fallback)).toBeNull();
  });

  test("a reserved slug or reserved prefix derives nothing", () => {
    expect(botUsernamePlan("mod_frank").derived).toEqual([]);
    expect(botUsernamePlan("admin").derived).toEqual([]);
    // `staff` is reserved, and `staff_bot` would be too (the `staff_` prefix).
    expect(botUsernamePlan("staff").derived).toEqual([]);
    // `demo` is free, but `demo_bot` takes the demo seed's prefix.
    expect(botUsernamePlan("demo").derived).toEqual([]);
  });

  test("an uppercase slug is lowercased", () => {
    expect(botUsernamePlan("Grace").derived[0]).toBe("grace_bot");
  });
});

describe("command list visibility", () => {
  const cmds = [
    { name: "a", enabled: true },
    { name: "b", enabled: false },
    { name: "c", enabled: true },
  ];

  test("viewers and anonymous callers see enabled commands only", () => {
    expect(visibleCommands(cmds, null).map((c) => c.name)).toEqual(["a", "c"]);
  });

  test.each(["owner", "editor", "moderator"] as const)("%s sees every command", (who) => {
    expect(visibleCommands(cmds, who).map((c) => c.name)).toEqual(["a", "b", "c"]);
  });

  test("an empty list stays empty", () => {
    expect(visibleCommands([], null)).toEqual([]);
    expect(visibleCommands([], "owner")).toEqual([]);
  });
});

describe("command names", () => {
  test("aliases are deduplicated and never repeat the command name", () => {
    expect(normalizeAliases("hello", ["hi", "hey", "hi", "hello"])).toEqual(["hi", "hey"]);
    expect(normalizeAliases("hello", [])).toEqual([]);
  });

  test("built-in names are found among names and aliases", () => {
    expect(builtinClash(["hello", "hi"])).toBeNull();
    expect(builtinClash(["points"])).toBe("points");
    expect(builtinClash(["hello", "sr"])).toBe("sr");
    expect(builtinClash(["commands"])).toBe("commands");
  });
});

describe("readBotConfig", () => {
  test("missing or invalid configs read as the defaults", () => {
    expect(readBotConfig(null)).toEqual(readBotConfig({}));
    expect(readBotConfig({ displayName: "" }).displayName).toBe("ChannelBot");
  });

  test("an old loyalty shape loses the per-channel rates", () => {
    const c = readBotConfig({ loyalty: { enabled: false, pointsName: "beans", perFiveMinutes: 10 } });
    expect(c.loyalty).toEqual({ enabled: false, pointsName: "beans" });
  });
});
