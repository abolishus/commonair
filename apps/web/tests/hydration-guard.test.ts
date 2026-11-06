// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BOOT_RELOAD_KEY,
  BOOT_RELOAD_WINDOW_MS,
  ONE_TIME_PARAMS,
  bootDecision,
  type BootState,
  hasOneTimeParam,
  sessionStore,
} from "../src/hydration-guard.ts";

function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

const doc = {};
const NOW = 1_800_000_000_000;
const state = (over: Partial<BootState> = {}): BootState => ({
  entryDocument: doc,
  currentDocument: doc,
  bootstrap: { buffer: [] },
  storage: memory(),
  now: NOW,
  search: "",
  ...over,
});

describe("bootDecision", () => {
  it("hydrates when the bootstrap is there, and records nothing", () => {
    const storage = memory();
    expect(bootDecision(state({ storage }))).toBe("hydrate");
    expect(storage.map.size).toBe(0);
  });

  it("does nothing for a document the window no longer shows", () => {
    const storage = memory();
    expect(bootDecision(state({ currentDocument: {}, bootstrap: undefined, storage }))).toBe("stale");
    // Even with the bootstrap there: the entry must not hydrate a document it was not loaded for.
    expect(bootDecision(state({ currentDocument: {} }))).toBe("stale");
    expect(storage.map.size).toBe(0);
  });

  it("reloads once when the bootstrap is missing, and remembers when", () => {
    const storage = memory();
    expect(bootDecision(state({ bootstrap: undefined, storage }))).toBe("reload");
    expect(storage.map.get(BOOT_RELOAD_KEY)).toBe(String(NOW));
  });

  it("treats a null or non-object bootstrap as missing", () => {
    expect(bootDecision(state({ bootstrap: null }))).toBe("reload");
    expect(bootDecision(state({ bootstrap: "x" }))).toBe("reload");
  });

  it("does not reload again within the window (no loop)", () => {
    const storage = memory({ [BOOT_RELOAD_KEY]: String(NOW - 1_000) });
    expect(bootDecision(state({ bootstrap: undefined, storage }))).toBe("missing");
    const edge = memory({ [BOOT_RELOAD_KEY]: String(NOW - BOOT_RELOAD_WINDOW_MS + 1) });
    expect(bootDecision(state({ bootstrap: undefined, storage: edge }))).toBe("missing");
  });

  it("reloads again once the window has passed", () => {
    const storage = memory({ [BOOT_RELOAD_KEY]: String(NOW - BOOT_RELOAD_WINDOW_MS) });
    expect(bootDecision(state({ bootstrap: undefined, storage }))).toBe("reload");
    expect(storage.map.get(BOOT_RELOAD_KEY)).toBe(String(NOW));
  });

  it("ignores a garbage or future timestamp", () => {
    for (const value of ["nope", "0", "-5", String(NOW + 10_000)]) {
      const storage = memory({ [BOOT_RELOAD_KEY]: value });
      expect(bootDecision(state({ bootstrap: undefined, storage }))).toBe("reload");
    }
  });

  it("never reloads without storage to remember it in", () => {
    expect(bootDecision(state({ bootstrap: undefined, storage: null }))).toBe("missing");
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(bootDecision(state({ bootstrap: undefined, storage: throwing }))).toBe("missing");
    const unreadable = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => undefined,
    };
    expect(bootDecision(state({ bootstrap: undefined, storage: unreadable }))).toBe("reload");
  });
});

describe("one-time URL parameters", () => {
  it("are recognised by name, case-insensitively, with or without a value", () => {
    expect(ONE_TIME_PARAMS).toEqual(["token", "code", "state", "nonce"]);
    for (const search of [
      "?token=abc",
      "?code=x&state=y",
      "?a=1&nonce=n",
      "?Code=x",
      "?STATE",
      "token=t",
      "?x=1&token=",
    ])
      expect(hasOneTimeParam(search), search).toBe(true);
  });

  it("are not matched by values, prefixes or look-alike names", () => {
    for (const search of [
      "",
      "?",
      "?q=token",
      "?tokens=1",
      "?access_token_hint=1",
      "?zipcode=1",
      "?statement=2",
      "?ref=code",
    ])
      expect(hasOneTimeParam(search), search).toBe(false);
  });

  it("are never reloaded for: a missing bootstrap hydrates anyway, and nothing is recorded", () => {
    const storage = memory();
    expect(bootDecision(state({ bootstrap: undefined, storage, search: "?code=abc&state=xyz" }))).toBe("missing");
    expect(bootDecision(state({ bootstrap: undefined, storage, search: "?token=t" }))).toBe("missing");
    expect(storage.map.size).toBe(0);
  });

  it("do not change a page that has its bootstrap, or one that is stale", () => {
    expect(bootDecision(state({ search: "?token=t" }))).toBe("hydrate");
    expect(bootDecision(state({ currentDocument: {}, bootstrap: undefined, search: "?token=t" }))).toBe("stale");
  });

  it("other parameters still reload once", () => {
    const storage = memory();
    expect(bootDecision(state({ bootstrap: undefined, storage, search: "?tab=refunds&page=2" }))).toBe("reload");
    expect(storage.map.get(BOOT_RELOAD_KEY)).toBe(String(NOW));
  });
});

describe("sessionStore", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is the window's sessionStorage", () => {
    const storage = memory();
    vi.stubGlobal("window", { sessionStorage: storage });
    expect(sessionStore()).toBe(storage);
  });

  it("is null where touching it throws (blocked storage, sandboxed frame)", () => {
    vi.stubGlobal(
      "window",
      Object.defineProperty({}, "sessionStorage", {
        get() {
          throw new DOMException("denied", "SecurityError");
        },
      }),
    );
    expect(sessionStore()).toBeNull();
  });
});
