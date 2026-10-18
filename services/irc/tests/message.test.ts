// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { LineFramer, splitFrame } from "../src/irc/framer.ts";
import { escapeTagValue, parseMessage, serializeMessage, unescapeTagValue } from "../src/irc/message.ts";

describe("tag escaping", () => {
  test.each([
    ["a;b", "a\\:b"],
    ["a b", "a\\sb"],
    ["a\\b", "a\\\\b"],
    ["a\rb\nc", "a\\rb\\nc"],
    ["plain", "plain"],
    ["", ""],
  ])("%j <-> %j", (raw, escaped) => {
    expect(escapeTagValue(raw)).toBe(escaped);
    expect(unescapeTagValue(escaped)).toBe(raw);
  });

  test("unknown escapes drop the backslash and a lone trailing backslash is dropped", () => {
    expect(unescapeTagValue("a\\bc")).toBe("abc");
    expect(unescapeTagValue("abc\\")).toBe("abc");
  });

  test("round-trips arbitrary strings", () => {
    for (const s of ["; \\ \r\n", "\\s\\:", "emoji 🎉 ; x", "\\\\;;  "])
      expect(unescapeTagValue(escapeTagValue(s))).toBe(s);
  });
});

describe("parseMessage", () => {
  test("tags, prefix, command, middle and trailing params", () => {
    const m = parseMessage(
      "@badges=broadcaster/1;color=#FF0000;flag :ronni!ronni@ronni.tmi.twitch.tv PRIVMSG #dallas :Kappa Keepo",
    );
    expect(m).toEqual({
      tags: { badges: "broadcaster/1", color: "#FF0000", flag: "" },
      prefix: "ronni!ronni@ronni.tmi.twitch.tv",
      command: "PRIVMSG",
      params: ["#dallas", "Kappa Keepo"],
      hasTrailing: true,
    });
  });

  test("unescapes tag values", () => {
    expect(parseMessage("@system-msg=hello\\sworld\\:\\\\ NOTICE * :x")?.tags["system-msg"]).toBe("hello world;\\");
  });

  test("no prefix, no params; command is uppercased", () => {
    expect(parseMessage("ping")).toMatchObject({ command: "PING", params: [], prefix: null, hasTrailing: false });
  });

  test("empty trailing param is kept", () => {
    expect(parseMessage(":tmi.twitch.tv CLEARMSG #c :")?.params).toEqual(["#c", ""]);
  });

  test("trailing may contain colons and repeated spaces", () => {
    expect(parseMessage("PRIVMSG #c :a :b  c")?.params).toEqual(["#c", "a :b  c"]);
  });

  test("tolerates multiple spaces between parts and strips CRLF", () => {
    expect(parseMessage("CAP   REQ   :twitch.tv/tags\r\n")?.params).toEqual(["REQ", "twitch.tv/tags"]);
  });

  test("numeric commands", () => {
    expect(parseMessage(":tmi.twitch.tv 001 me :Welcome")?.command).toBe("001");
  });

  test.each(["", "   ", "@tags-only", ":prefix-only", "@a=b :p", "BAD!CMD x", "12 x"])(
    "rejects malformed %j",
    (line) => {
      expect(parseMessage(line)).toBeNull();
    },
  );
});

describe("serializeMessage", () => {
  test("writes Twitch shape with explicit empty tag values", () => {
    expect(
      serializeMessage({
        tags: { "badge-info": "", badges: "moderator/1", "display-name": "A B;C" },
        prefix: "a!a@a.tmi.twitch.tv",
        command: "PRIVMSG",
        params: ["#chan"],
        trailing: "hello",
      }),
    ).toBe("@badge-info=;badges=moderator/1;display-name=A\\sB\\:C :a!a@a.tmi.twitch.tv PRIVMSG #chan :hello");
  });

  test("always writes a trailing colon, even when empty", () => {
    expect(serializeMessage({ command: "CLEARMSG", params: ["#c"], trailing: "" })).toBe("CLEARMSG #c :");
  });

  test("omits empty tag maps and missing parts", () => {
    expect(serializeMessage({ tags: {}, command: "RECONNECT", prefix: "tmi.twitch.tv" })).toBe(
      ":tmi.twitch.tv RECONNECT",
    );
  });

  test("strips CR/LF/NUL from the trailing param to prevent line injection", () => {
    expect(serializeMessage({ command: "PRIVMSG", params: ["#c"], trailing: "a\r\nQUIT\0" })).toBe(
      "PRIVMSG #c :a  QUIT ",
    );
  });

  test.each(["", "a b", ":x"])("refuses invalid middle param %j", (p) => {
    expect(() => serializeMessage({ command: "JOIN", params: [p] })).toThrow(/invalid middle IRC param/);
  });

  test("parse(serialize(x)) round-trips", () => {
    const out = {
      tags: { a: "x y;z", b: "" },
      prefix: "tmi.twitch.tv",
      command: "USERNOTICE",
      params: ["#c"],
      trailing: "msg: with :colons",
    };
    expect(parseMessage(serializeMessage(out))).toEqual({
      tags: out.tags,
      prefix: out.prefix,
      command: out.command,
      params: ["#c", out.trailing],
      hasTrailing: true,
    });
  });
});

function collect(max: number) {
  const lines: string[] = [];
  let overflows = 0;
  const framer = new LineFramer(max, { line: (l) => lines.push(l), overflow: () => overflows++ });
  return {
    framer,
    lines,
    get overflows() {
      return overflows;
    },
  };
}
const enc = (s: string) => new TextEncoder().encode(s);

describe("LineFramer (byte streams)", () => {
  test("splits CRLF and bare LF, buffers partial lines across chunks", () => {
    const c = collect(100);
    c.framer.push(enc("PING\r\nNICK a\nPR"));
    c.framer.push(enc("IVMSG #c :hi\r"));
    expect(c.lines).toEqual(["PING", "NICK a"]);
    c.framer.push(enc("\n"));
    expect(c.lines).toEqual(["PING", "NICK a", "PRIVMSG #c :hi"]);
  });

  test("ignores empty lines", () => {
    const c = collect(100);
    c.framer.push(enc("\r\n\r\nPING\r\n\n"));
    expect(c.lines).toEqual(["PING"]);
  });

  test("decodes UTF-8 split across chunks", () => {
    const c = collect(100);
    const bytes = enc("PRIVMSG #c :🎉\r\n");
    c.framer.push(bytes.subarray(0, 14));
    c.framer.push(bytes.subarray(14));
    expect(c.lines).toEqual(["PRIVMSG #c :🎉"]);
  });

  test("drops an overlong line whole (even when it arrives in pieces) and resumes after it", () => {
    const c = collect(10);
    c.framer.push(enc("AAAAAAAA"));
    c.framer.push(enc("AAAAAAAA"));
    c.framer.push(enc("AAAA\r\nPING\r\n"));
    expect(c.lines).toEqual(["PING"]);
    expect(c.overflows).toBe(1);
  });

  test("a line of exactly the limit is accepted", () => {
    const c = collect(10);
    c.framer.push(enc("0123456789\n"));
    expect(c.lines).toEqual(["0123456789"]);
  });
});

describe("splitFrame (WebSocket frames)", () => {
  test("one line per frame without CRLF (tmi.js) and several lines in one frame", () => {
    const lines: string[] = [];
    const sink = { line: (l: string) => lines.push(l), overflow: () => lines.push("<overflow>") };
    splitFrame("NICK a", 100, sink);
    splitFrame("CAP REQ :twitch.tv/tags\r\nPASS oauth:x\r\nNICK b\r\n", 100, sink);
    splitFrame(`${"x".repeat(101)}\nPING`, 100, sink);
    expect(lines).toEqual(["NICK a", "CAP REQ :twitch.tv/tags", "PASS oauth:x", "NICK b", "<overflow>", "PING"]);
  });
});
