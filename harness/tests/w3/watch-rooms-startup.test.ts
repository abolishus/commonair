// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `watch-room` start-up diagnostics (`src/w3/watch-rooms/startup.ts`). */
import { describe, expect, it } from "vite-plus/test";
import {
  CONSOLE_CHARS,
  CONSOLE_KEEP,
  consoleBuffer,
  summarizeStartup,
  withStartup,
  type StartupRaw,
} from "../../src/w3/watch-rooms/startup.ts";

const HYDRATE_ERROR = "undefined is not an object (evaluating 't.t=new Map(n.map(e=>[e.key,e.fromSerializable]))')";

const raw = (over: Partial<StartupRaw> = {}): StartupRaw => ({
  path: "/wredge_1?room=r1&invite=nonce-secret",
  readyState: "complete",
  navigationType: "navigate",
  hydrated: false,
  boot: null,
  bootstrap: "absent",
  players: 0,
  scripts: [
    { src: null, type: "", async: false, inline: '(self.$R=self.$R||{})["tsr"]=[];self.$_TSR={h(){' },
    { src: "/assets/index-BAMaaIx0.js?invite=abc", type: "module", async: true, inline: null },
  ],
  ...over,
});

describe("summarizeStartup", () => {
  it("names the scripts in document order, by path or their first characters", () => {
    const d = summarizeStartup(raw(), []);
    expect(d.scripts).toEqual([
      'classic inline ((self.$R=self.$R||{})["tsr"]=[];self.$_TSR={h(){',
      "module async /assets/index-BAMaaIx0.js",
    ]);
  });

  it("keeps the path only: no invite nonce or token from the query", () => {
    const d = summarizeStartup(raw(), []);
    expect(d.path).toBe("/wredge_1");
    expect(JSON.stringify(d)).not.toContain("nonce-secret");
    expect(JSON.stringify(d)).not.toContain("invite=abc");
  });

  it("carries the page's state and console through", () => {
    const d = summarizeStartup(raw({ boot: "missing", hydrated: false }), [`pageerror: ${HYDRATE_ERROR}`]);
    expect(d).toMatchObject({
      readyState: "complete",
      navigationType: "navigate",
      hydrated: false,
      boot: "missing",
      bootstrap: "absent",
      players: 0,
      console: [`pageerror: ${HYDRATE_ERROR}`],
    });
  });

  it("scrubs secrets that reach an inline script's first characters or a console line", () => {
    const d = summarizeStartup(
      raw({ scripts: [{ src: null, type: "", async: false, inline: "fetch('/x?token=abcdef')" }] }),
      ["error: GET /api/x?invite=n0nce failed"],
    );
    expect(d.scripts[0]).toContain("token=REDACTED");
    expect(d.console[0]).toBe("error: GET /api/x?invite=REDACTED failed");
  });
});

describe("consoleBuffer", () => {
  it("keeps the last lines only, each cut short", () => {
    const buf = consoleBuffer();
    for (let i = 0; i < CONSOLE_KEEP + 5; i++) buf.push(`line ${i}`);
    const lines = buf.lines();
    expect(lines).toHaveLength(CONSOLE_KEEP);
    expect(lines[0]).toBe("line 5");
    expect(lines.at(-1)).toBe(`line ${CONSOLE_KEEP + 4}`);
    buf.push("x".repeat(CONSOLE_CHARS * 2));
    expect(buf.lines().at(-1)).toHaveLength(CONSOLE_CHARS);
  });

  it("scrubs as it keeps", () => {
    const buf = consoleBuffer();
    buf.push("warning: /overlay/chat?token=s3cret");
    expect(buf.lines()).toEqual(["warning: /overlay/chat?token=REDACTED"]);
  });
});

describe("withStartup", () => {
  it("appends the diagnostics to the step's error and keeps the cause", () => {
    const cause = new Error("waitFor: Timeout 90000ms exceeded.");
    const err = withStartup(cause, summarizeStartup(raw(), []));
    expect(err.message.split("\n")[0]).toBe("waitFor: Timeout 90000ms exceeded.");
    expect(err.message).toContain('start-up: {"path":"/wredge_1"');
    expect(err.cause).toBe(cause);
  });

  it("says so when the page could not be read", () => {
    expect(withStartup("boom", null).message).toBe("boom\nstart-up: unreadable");
  });
});
