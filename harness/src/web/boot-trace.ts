// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A per-tab trace of TanStack Start's bootstrap (`window.$_TSR`), for the WebKit start-up flake
 * where hydration found no bootstrap (CI runs 41922495854, 42134001057, 42215129857, 42255758489).
 * Since the web app's hydration guard (`apps/web/src/hydration-guard.ts`) reloads such a page,
 * the miss no longer fails a run and left no trace at all: no failing run ever carried the
 * page-error diagnostics (`hydration.ts`). This records, for each document, when the bootstrap
 * was set, when the stream ended, when a hydration marked it done and from which script, and
 * when it was deleted, in `sessionStorage` so the entry for the document that missed survives
 * the guard's reload. The session logs it whenever the guard fires.
 *
 * What it tells apart: `setMs` null is a document that never ran its bootstrap; `deletedMs`
 * before the guard fired is an earlier hydration that cleaned it up (`hydratedBy` names whose
 * script called `h()`); set and not deleted is a guard that ran ahead of the bootstrap.
 */

/** `sessionStorage` key of the trace (one tab, every document it showed on the web origin). */
export const BOOT_TRACE_KEY = "harness-boot-trace";
/** Documents kept, newest last. */
export const BOOT_TRACE_KEEP = 12;

/** One document's bootstrap, times in ms since that document's navigation started. */
export interface BootTraceEntry {
  /** `performance.timeOrigin` of the document (epoch ms, rounded): tells documents apart. */
  origin: number;
  path: string;
  /** `PerformanceNavigationTiming.type` (navigate, reload, back_forward). */
  nav: string;
  /** First assignment of `$_TSR`, and the `readyState` then. */
  setMs: number | null;
  setReadyState: string | null;
  /** Assignments of `$_TSR` (more than one means two bootstraps in one document). */
  sets: number;
  /** `$_TSR.e()`: the server's stream ended. */
  streamEndMs: number | null;
  /** `$_TSR.h()`: a hydration finished, and the script paths on its stack (no queries). */
  hydratedMs: number | null;
  hydratedBy: string[];
  /** `$_TSR.c()` deleted the bootstrap. */
  deletedMs: number | null;
}

interface TraceGlobal {
  sessionStorage?: Pick<Storage, "getItem" | "setItem">;
  performance: {
    now(): number;
    timeOrigin: number;
    getEntriesByType(type: string): { type?: string }[];
    /** `PerformanceNavigation` (deprecated, but there from the first script on in every engine). */
    navigation?: { type: number };
  };
  location: { pathname: string };
  document: { readyState: string };
}

/**
 * The init script (`context.addInitScript(installBootTrace)`): Playwright serializes it, so it is
 * self-contained, takes the global as an argument only for the unit tests, and never throws.
 * `$_TSR` becomes an accessor before any page script runs; the bootstrap's assignment, its
 * `delete` and every read behave as on a plain property, except that a read before the bootstrap
 * ran is `undefined` rather than a ReferenceError.
 */
export function installBootTrace(target?: unknown): void {
  try {
    const g = (target ?? globalThis) as TraceGlobal & Record<string, unknown>;
    const key = "harness-boot-trace";
    const keep = 12;
    const ms = () => Math.round(g.performance.now());
    // WebKit has no navigation entry yet at document start: fall back to the legacy numeric type.
    const legacy = ["navigate", "reload", "back_forward"][g.performance.navigation?.type ?? -1];
    const nav = g.performance.getEntriesByType("navigation")[0]?.type ?? legacy ?? "unknown";
    const entry: BootTraceEntry = {
      origin: Math.round(g.performance.timeOrigin),
      path: g.location.pathname,
      nav,
      setMs: null,
      setReadyState: null,
      sets: 0,
      streamEndMs: null,
      hydratedMs: null,
      hydratedBy: [],
      deletedMs: null,
    };
    const paths = (stack: string) => {
      const out: string[] = [];
      for (const m of stack.matchAll(/https?:\/\/[^/\s)]+(\/[^?#\s):]*)/g)) {
        const p = m[1];
        if (p && !out.includes(p)) out.push(p);
        if (out.length >= 4) break;
      }
      return out;
    };
    const save = () => {
      try {
        const store = g.sessionStorage;
        if (!store) return;
        const raw = JSON.parse(store.getItem(key) ?? "[]") as unknown;
        const list = (Array.isArray(raw) ? raw : []) as BootTraceEntry[];
        const rest = list.filter((e) => !(e.origin === entry.origin && e.path === entry.path));
        store.setItem(key, JSON.stringify([...rest, entry].slice(-keep)));
      } catch {
        // Storage blocked or full: the trace is best effort.
      }
    };
    // `before` runs ahead of the original, which may go on to call `c()` and delete the bootstrap.
    const wrap = (obj: Record<string, unknown>, name: string, before: () => void, after: () => void) => {
      const orig = obj[name];
      if (typeof orig !== "function") return;
      obj[name] = function (this: unknown, ...args: unknown[]) {
        before();
        const result = (orig as (...a: unknown[]) => unknown).apply(this, args);
        after();
        return result;
      };
    };
    const none = () => undefined;
    let value: unknown;
    Object.defineProperty(g, "$_TSR", {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (v: unknown) => {
        value = v;
        entry.sets++;
        if (entry.setMs === null) {
          entry.setMs = ms();
          entry.setReadyState = g.document.readyState;
        }
        if (typeof v === "object" && v !== null) {
          const obj = v as Record<string, unknown>;
          wrap(
            obj,
            "e",
            () => {
              entry.streamEndMs ??= ms();
            },
            save,
          );
          wrap(
            obj,
            "h",
            () => {
              if (entry.hydratedMs !== null) return;
              entry.hydratedMs = ms();
              entry.hydratedBy = paths(new Error("h").stack ?? "");
            },
            save,
          );
          wrap(obj, "c", none, () => {
            if (entry.deletedMs === null && !Object.hasOwn(g, "$_TSR")) {
              entry.deletedMs = ms();
              save();
            }
          });
        }
        save();
      },
    });
    save();
  } catch {
    // Never break the page under test.
  }
}

/** Runs in the page (`page.evaluate`): the tab's trace, or null when there is none or it is unreadable. */
export function readBootTrace(): BootTraceEntry[] | null {
  try {
    const raw = sessionStorage.getItem("harness-boot-trace");
    const list = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(list) ? (list as BootTraceEntry[]) : null;
  } catch {
    return null;
  }
}

/** The guard's console line (`apps/web/src/client.tsx`): "hydration bootstrap missing; …". Pure. */
export function isHydrationGuardMessage(text: string): boolean {
  return text.startsWith("hydration bootstrap missing");
}
