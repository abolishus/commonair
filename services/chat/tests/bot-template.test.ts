// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { CHAT_LIMITS } from "@commonair/contracts";
import {
  cutText,
  formatUptime,
  renderTemplate,
  templateNeeds,
  type TemplateVars,
} from "../src/plugins/bot/template.ts";

const vars: TemplateVars = {
  user: "Alice",
  touser: "bob",
  count: 7,
  channel: "Streamer",
  uptime: "1h 2m",
  points: 120,
  pointsName: "beans",
  variables: new Map([
    ["game", "Chess"],
    ["empty", ""],
  ]),
};

describe("renderTemplate", () => {
  test.each([
    ["Hi ${user}!", "Hi Alice!"],
    ["${user} hugs ${touser}", "Alice hugs bob"],
    ["used ${count} times", "used 7 times"],
    ["welcome to ${channel}", "welcome to Streamer"],
    ["live for ${uptime}", "live for 1h 2m"],
    ["${points} ${pointsName}", "120 beans"],
    ["playing ${var:game}", "playing Chess"],
    ["[${var:empty}]", "[]"],
  ])("%s", (template, out) => {
    expect(renderTemplate(template, vars)).toBe(out);
  });

  test("every variable in one template", () => {
    expect(
      renderTemplate("${user} ${touser} ${count} ${channel} ${uptime} ${points} ${pointsName} ${var:game}", vars),
    ).toBe("Alice bob 7 Streamer 1h 2m 120 beans Chess");
  });

  test("unknown variables render literally", () => {
    expect(renderTemplate("${nope} ${var:missing} ${USER}", vars)).toBe("${nope} ${var:missing} ${USER}");
  });

  test("a variable without a value renders literally", () => {
    expect(renderTemplate("${user} ${points}", { user: "A" })).toBe("A ${points}");
  });

  test("malformed references are text", () => {
    expect(renderTemplate("${", vars)).toBe("${");
    expect(renderTemplate("${user", vars)).toBe("${user");
    expect(renderTemplate("$user {user} $ {", vars)).toBe("$user {user} $ {");
    expect(renderTemplate("${}", vars)).toBe("${}");
    expect(renderTemplate("${ user }", vars)).toBe("${ user }");
    expect(renderTemplate("${var:Bad-Name}", vars)).toBe("${var:Bad-Name}");
    expect(renderTemplate("${constructor} ${toString} ${__proto__}", vars)).toBe(
      "${constructor} ${toString} ${__proto__}",
    );
  });

  test("nested-looking input is never expanded twice", () => {
    expect(renderTemplate("${var:${user}}", vars)).toBe("${var:Alice}");
    const sneaky: TemplateVars = { ...vars, user: "${var:game}", touser: "${touser}" };
    expect(renderTemplate("${user} ${touser}", sneaky)).toBe("${var:game} ${touser}");
    expect(renderTemplate("${var:game}", { variables: new Map([["game", "${user}"]]), user: "A" })).toBe("${user}");
  });

  test("dollar signs in values are copied as is", () => {
    expect(renderTemplate("${user}", { user: "$& $1 $$" })).toBe("$& $1 $$");
  });

  test("cut to the chat body limit", () => {
    const long = "x".repeat(600);
    expect(renderTemplate(long, vars)).toHaveLength(CHAT_LIMITS.maxBodyLength);
    expect(renderTemplate("${user}", { user: "y".repeat(1_000) })).toHaveLength(CHAT_LIMITS.maxBodyLength);
    expect(renderTemplate("${user}${user}", { user: "ab" }, 3)).toBe("aba");
  });

  test("a huge reference-heavy template stays bounded", () => {
    const out = renderTemplate("${user}".repeat(10_000), { user: "z".repeat(100) });
    expect(out).toHaveLength(CHAT_LIMITS.maxBodyLength);
  });

  test("an empty template renders empty", () => {
    expect(renderTemplate("", vars)).toBe("");
  });
});

describe("cutText", () => {
  test("never leaves half a surrogate pair", () => {
    expect(cutText("ab😀", 3)).toBe("ab");
    expect(cutText("ab😀", 4)).toBe("ab😀");
    expect(cutText("abc", 5)).toBe("abc");
  });
});

describe("templateNeeds", () => {
  test("names the costly variables only when used", () => {
    expect(templateNeeds("Hi ${user}")).toEqual({ points: false, uptime: false, variables: false });
    expect(templateNeeds("${points} ${uptime} ${var:x}")).toEqual({ points: true, uptime: true, variables: true });
  });
});

describe("formatUptime", () => {
  test.each([
    [0, "0s"],
    [-5, "0s"],
    [59_999, "59s"],
    [60_000, "1m"],
    [3_599_000, "59m"],
    [3_600_000, "1h 0m"],
    [3_600_000 * 26 + 61_000, "26h 1m"],
  ])("%d ms → %s", (ms, out) => {
    expect(formatUptime(ms)).toBe(out);
  });
});
