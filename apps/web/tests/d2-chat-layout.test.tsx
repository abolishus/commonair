// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * D2-chat's column (design review F6): bounded under the player below `lg`, sticky and the
 * viewport's height less the header and page padding on `lg`, and the theatre height in theatre.
 * The `lg` rules are plain CSS (`layout.css`), read here as text.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { CHAT_COLUMN_CLASS, chatColumnClass } from "../src/chat/layout.ts";

const css = readFileSync(new URL("../src/chat/layout.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const classes = (s: string) => s.split(/\s+/).filter(Boolean);

/** The declarations of `selector`'s rule inside the `lg` media query. */
function lgRule(selector: string): Record<string, string> {
  const media = /@media \(min-width: 64rem\) \{([\s\S]*)\}\s*$/.exec(css.trim())?.[1] ?? "";
  const escaped = selector.replace(/\./g, "\\.");
  const body = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(media)?.[1] ?? "";
  return Object.fromEntries(
    body
      .split(";")
      .map((d) => d.split(":").map((p) => p.trim()))
      .filter((p): p is [string, string] => p.length === 2 && p[0] !== ""),
  );
}

describe("chatColumnClass", () => {
  it("below lg: a bounded height under the player, in and out of theatre", () => {
    expect(classes(chatColumnClass({ theatre: false }))).toEqual(["h-112", "chat-column"]);
    expect(classes(chatColumnClass({ theatre: true }))).toEqual(["h-112", "chat-column", "chat-column-theatre"]);
  });

  it("on lg (Tailwind's 64rem): sticky, the viewport less the 3.5rem header and 2rem of page padding", () => {
    expect(lgRule(".chat-column")).toEqual({
      position: "sticky",
      top: "1rem",
      height: "calc(100svh - 5.5rem)",
      "min-height": "24rem",
    });
  });

  it("in theatre: docked at the top, the viewport less the header", () => {
    expect(lgRule(".chat-column.chat-column-theatre")).toEqual({ top: "0", height: "calc(100svh - 3.5rem)" });
  });

  it("no longer uses the fixed lg:h-160, and the constant is the non-theatre column", () => {
    for (const theatre of [false, true]) expect(chatColumnClass({ theatre })).not.toContain("h-160");
    expect(CHAT_COLUMN_CLASS).toBe(chatColumnClass({ theatre: false }));
  });
});
