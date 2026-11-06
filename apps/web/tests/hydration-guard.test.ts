// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import { BOOT_RELOAD_KEY, BOOT_RELOAD_WINDOW_MS, bootDecision, type BootState } from "../src/hydration-guard.ts";

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
