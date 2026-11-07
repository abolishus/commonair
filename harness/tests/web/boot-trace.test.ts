// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The bootstrap trace's init script over a stand-in of the browser globals it touches (Bun has no
 * DOM), driven by a bootstrap shaped like TanStack Start's (`self.$_TSR={h,e,c,p,buffer}`): the
 * three ways a page can find no bootstrap must leave three different traces.
 * tests/web/boot-trace.int.test.ts runs it in Chromium and WebKit through a WebSession.
 */
import { describe, expect, test } from "vite-plus/test";
import {
  BOOT_TRACE_KEEP,
  BOOT_TRACE_KEY,
  type BootTraceEntry,
  installBootTrace,
  isHydrationGuardMessage,
} from "../../src/web/boot-trace.ts";

/** TanStack Start's inline bootstrap, run with `self` bound to the stand-in global. */
const BOOTSTRAP =
  "self.$_TSR={h(){this.hydrated=!0,this.c()},e(){this.streamEnded=!0,this.c()},c(){this.hydrated&&this.streamEnded&&(delete self.$_TSR,delete self.$R.tsr)},p(e){this.initialized?e():this.buffer.push(e)},buffer:[]}";

class MemoryStorage {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
}

interface Clock {
  now: number;
}

function fakeWindow(opts: {
  storage?: MemoryStorage | "throws" | null;
  path?: string;
  origin?: number;
  nav?: string;
  clock?: Clock;
}) {
  const clock = opts.clock ?? { now: 0 };
  const storage =
    opts.storage === "throws"
      ? {
          getItem: () => {
            throw new Error("SecurityError");
          },
          setItem: () => {
            throw new Error("SecurityError");
          },
        }
      : (opts.storage ?? undefined);
  const g: Record<string, unknown> = {
    $R: { tsr: [] },
    sessionStorage: storage ?? undefined,
    performance: {
      now: () => clock.now,
      timeOrigin: opts.origin ?? 1_700_000_000_000,
      getEntriesByType: (t: string) => (t === "navigation" ? [{ type: opts.nav ?? "navigate" }] : []),
    },
    location: { pathname: opts.path ?? "/chan" },
    document: { readyState: "loading" },
  };
  return { g, clock };
}

/** Run inline page code with `self` bound to the stand-in, as a classic script would see it. */
function run(g: Record<string, unknown>, code: string): void {
  // oxlint-disable-next-line typescript/no-implied-eval -- the bootstrap is an inline script string in the real page.
  new Function("self", code)(g);
}

function trace(storage: MemoryStorage): BootTraceEntry[] {
  return JSON.parse(storage.getItem(BOOT_TRACE_KEY) ?? "[]") as BootTraceEntry[];
}

describe("installBootTrace", () => {
  test("a normal start-up: set, stream end, hydration and cleanup, in that document's times", () => {
    const storage = new MemoryStorage();
    const { g, clock } = fakeWindow({ storage });
    installBootTrace(g);
    expect(trace(storage)).toEqual([expect.objectContaining({ path: "/chan", nav: "navigate", setMs: null, sets: 0 })]);

    clock.now = 12.4;
    run(g, BOOTSTRAP);
    expect(typeof (g.$_TSR as { h?: unknown }).h).toBe("function");
    clock.now = 80;
    run(g, "self.$_TSR.e()");
    clock.now = 140;
    // The entry module: TanStack's hydrate reads it, then `h()` marks it done and cleans up.
    expect((g.$_TSR as { buffer: unknown[] }).buffer).toEqual([]);
    run(g, "self.$_TSR.h()");

    expect("$_TSR" in g).toBe(false);
    expect((g.$R as Record<string, unknown>).tsr).toBeUndefined();
    const [e] = trace(storage);
    expect(e).toMatchObject({
      origin: 1_700_000_000_000,
      setMs: 12,
      setReadyState: "loading",
      sets: 1,
      streamEndMs: 80,
      hydratedMs: 140,
      deletedMs: 140,
    });
  });

  test("a document that never ran its bootstrap: nothing set, and a read is undefined", () => {
    const storage = new MemoryStorage();
    const { g } = fakeWindow({ storage });
    installBootTrace(g);
    expect(Reflect.get(g, "$_TSR")).toBeUndefined();
    expect(trace(storage)).toEqual([
      expect.objectContaining({ setMs: null, streamEndMs: null, hydratedMs: null, deletedMs: null }),
    ]);
  });

  test("an earlier hydration cleaned it up: deleted before the entry looked, with the caller's script", () => {
    const storage = new MemoryStorage();
    const { g, clock } = fakeWindow({ storage });
    installBootTrace(g);
    run(g, BOOTSTRAP);
    clock.now = 50;
    run(g, "self.$_TSR.e()");
    clock.now = 60;
    // The stack of whoever called `h()`: a script from the web origin, query dropped.
    run(g, "self.$_TSR.h()\n//# sourceURL=http://web.test/assets/earlier-AbC.js?v=1");
    expect(Reflect.get(g, "$_TSR")).toBeUndefined();
    const [e] = trace(storage);
    expect(e?.deletedMs).toBe(60);
    expect(e?.hydratedMs).toBe(60);
    // JavaScriptCore reports a sourceURL'd script by that URL; only web paths are kept, no query.
    expect(e?.hydratedBy).toEqual(["/assets/earlier-AbC.js"]);
  });

  test("hydrated but the stream still open: kept, not deleted", () => {
    const storage = new MemoryStorage();
    const { g, clock } = fakeWindow({ storage });
    installBootTrace(g);
    run(g, BOOTSTRAP);
    clock.now = 30;
    run(g, "self.$_TSR.h()");
    expect(typeof Reflect.get(g, "$_TSR")).toBe("object");
    expect(trace(storage)[0]).toMatchObject({ hydratedMs: 30, deletedMs: null, streamEndMs: null });
  });

  test("a second bootstrap in one document is counted, and the first set time kept", () => {
    const storage = new MemoryStorage();
    const { g, clock } = fakeWindow({ storage });
    installBootTrace(g);
    clock.now = 5;
    run(g, BOOTSTRAP);
    clock.now = 9;
    run(g, BOOTSTRAP);
    expect(trace(storage)[0]).toMatchObject({ sets: 2, setMs: 5 });
  });

  test("after the cleanup the global is a plain property again", () => {
    const storage = new MemoryStorage();
    const { g } = fakeWindow({ storage });
    installBootTrace(g);
    run(g, BOOTSTRAP);
    run(g, "self.$_TSR.e(); self.$_TSR.h()");
    run(g, "self.$_TSR = { again: true }");
    expect(g.$_TSR).toEqual({ again: true });
    expect(Object.getOwnPropertyDescriptor(g, "$_TSR")).toMatchObject({ value: { again: true }, writable: true });
  });

  test("documents of one tab share the trace (the guard's reload keeps the one that missed), newest last, capped", () => {
    const storage = new MemoryStorage();
    for (let i = 0; i < BOOT_TRACE_KEEP + 3; i++) {
      const { g } = fakeWindow({ storage, origin: 1_000 + i, path: `/p${i}`, nav: i % 2 ? "reload" : "navigate" });
      installBootTrace(g);
    }
    const list = trace(storage);
    expect(list).toHaveLength(BOOT_TRACE_KEEP);
    expect(list.at(-1)).toMatchObject({ origin: 1_000 + BOOT_TRACE_KEEP + 2, path: `/p${BOOT_TRACE_KEEP + 2}` });
    expect(list[0]?.origin).toBe(1_003);
  });

  test("a document's later events update its own entry, not a new one", () => {
    const storage = new MemoryStorage();
    const missed = fakeWindow({ storage, origin: 1 });
    installBootTrace(missed.g);
    const reloaded = fakeWindow({ storage, origin: 2, nav: "reload" });
    installBootTrace(reloaded.g);
    run(reloaded.g, BOOTSTRAP);
    run(reloaded.g, "self.$_TSR.e(); self.$_TSR.h()");
    const list = trace(storage);
    expect(list.map((e) => [e.origin, e.nav, e.setMs !== null, e.deletedMs !== null])).toEqual([
      [1, "navigate", false, false],
      [2, "reload", true, true],
    ]);
  });

  test("blocked or missing storage never breaks the page", () => {
    for (const storage of ["throws", null] as const) {
      const { g } = fakeWindow({ storage });
      expect(() => installBootTrace(g)).not.toThrow();
      run(g, BOOTSTRAP);
      run(g, "self.$_TSR.e(); self.$_TSR.h()");
      expect("$_TSR" in g).toBe(false);
    }
  });

  test("a global it cannot define the property on is left alone", () => {
    const { g } = fakeWindow({ storage: new MemoryStorage() });
    Object.freeze(g);
    expect(() => installBootTrace(g)).not.toThrow();
  });
});

describe("isHydrationGuardMessage", () => {
  test("matches both of the guard's lines, nothing else", () => {
    expect(isHydrationGuardMessage("hydration bootstrap missing; reloading once")).toBe(true);
    expect(isHydrationGuardMessage("hydration bootstrap missing; hydrating without a reload")).toBe(true);
    expect(isHydrationGuardMessage("Failed to load resource")).toBe(false);
    expect(isHydrationGuardMessage("TypeError: hydration bootstrap missing")).toBe(false);
  });
});
