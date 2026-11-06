// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The in-page readers (`readBootState`, and `readStartup` through `startupDiagnostics`) over a
 * minimal stand-in of the browser globals they read, so their classification runs under the unit
 * tests: Bun has no DOM. tests/web/boot-state.int.test.ts runs the same readers in Chromium.
 */
import { afterEach, describe, expect, test } from "vite-plus/test";
import { startupDiagnostics } from "../../src/w3/watch-rooms/startup.ts";
import { readBootState } from "../../src/web/hydration.ts";

interface FakeScript {
  src: string;
  type: string;
  async: boolean;
  textContent: string | null;
  getAttribute(name: string): string | null;
}

interface FakePage {
  href?: string;
  readyState?: string;
  root?: Record<string, string>;
  scripts?: { src?: string; type?: string; async?: boolean; text?: string }[];
  players?: number;
  resources?: string[];
  navigation?: string | null;
  serviceWorker?: boolean | "absent";
  window?: Record<string, unknown>;
}

const KEYS = ["window", "document", "location", "performance", "navigator"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>(
  KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]),
);

afterEach(() => {
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(globalThis, k, d);
    else Reflect.deleteProperty(globalThis, k);
  }
});

/** Install the globals a page would have; `scripts` in document order. */
function install(p: FakePage): void {
  const href = p.href ?? "http://web.test/watch?room=r1&invite=secret";
  const url = new URL(href);
  const scripts: FakeScript[] = (p.scripts ?? []).map((s) => {
    const attrs: Record<string, string> = {};
    if (s.src !== undefined) attrs.src = s.src;
    if (s.type) attrs.type = s.type;
    return {
      src: s.src ? new URL(s.src, href).toString() : "",
      type: s.type ?? "",
      async: s.async ?? false,
      textContent: s.text ?? null,
      getAttribute: (n: string) => attrs[n] ?? null,
    };
  });
  const root = p.root ?? {};
  const documentElement = {
    dataset: Object.fromEntries(Object.entries(root).map(([k, v]) => [k.replace(/^data-/, ""), v])),
    hasAttribute: (n: string) => n in root,
    getAttribute: (n: string) => root[n] ?? null,
  };
  const document = {
    readyState: p.readyState ?? "complete",
    documentElement,
    scripts,
    querySelectorAll: (sel: string) => {
      if (sel === 'script[type="module"]') return scripts.filter((s) => s.type === "module");
      if (sel === '[data-testid="player"]') return Array.from({ length: p.players ?? 0 });
      throw new Error(`unexpected selector ${sel}`);
    },
  };
  const performance = {
    getEntriesByType: (type: string) =>
      type === "resource"
        ? (p.resources ?? []).map((name) => ({ name }))
        : p.navigation === null
          ? []
          : [{ type: p.navigation ?? "navigate" }],
  };
  const navigator = p.serviceWorker === "absent" ? {} : { serviceWorker: { controller: p.serviceWorker ? {} : null } };
  const win = { ...p.window };
  const define = (k: string, v: unknown) =>
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  define("window", win);
  define("document", document);
  define("location", { href, pathname: url.pathname });
  define("performance", performance);
  define("navigator", navigator);
}

describe("readBootState", () => {
  test("a window that never ran the bootstrap: neither $R nor $_TSR", () => {
    install({
      readyState: "interactive",
      scripts: [
        { src: "/assets/index-AbC.js", type: "module" },
        { type: "module", text: "import('x')" },
        { text: "1" },
      ],
      resources: ["http://web.test/assets/index-AbC.js", "http://web.test/assets/vendor-1.js", "/assets/index-AbC.js"],
      navigation: "reload",
      serviceWorker: false,
    });
    expect(readBootState()).toEqual({
      readyState: "interactive",
      seroval: "undefined",
      serovalTsr: false,
      tsr: "undefined",
      hydrated: false,
      serviceWorkerControls: false,
      moduleScripts: ["/assets/index-AbC.js", "inline"],
      entryFetches: 2,
      navigationType: "reload",
    });
  });

  test("a window an earlier hydration cleaned up: $R stays, its tsr and $_TSR are gone", () => {
    install({ window: { $R: { other: [] } }, root: { "data-hydrated": "true" }, serviceWorker: true });
    expect(readBootState()).toMatchObject({
      seroval: "object",
      serovalTsr: false,
      tsr: "undefined",
      hydrated: true,
      serviceWorkerControls: true,
      moduleScripts: [],
      entryFetches: 0,
    });
  });

  test("a bootstrap still in place; no navigation entry and no service worker API", () => {
    install({ window: { $R: { tsr: [] }, $_TSR: { h() {} } }, navigation: null, serviceWorker: "absent" });
    expect(readBootState()).toMatchObject({
      seroval: "object",
      serovalTsr: true,
      tsr: "object",
      serviceWorkerControls: false,
      navigationType: "unknown",
    });
  });

  test("$R set to null is not mistaken for the bootstrap", () => {
    install({ window: { $R: null } });
    expect(readBootState()).toMatchObject({ seroval: "object", serovalTsr: false });
  });
});

const BOOTSTRAP = '(self.$R=self.$R||{})["tsr"]=[];self.$_TSR={h(){}};$_TSR.router=($R=>$R[0]={})($R["tsr"])';

describe("startupDiagnostics, read in the page", () => {
  const page = { evaluate: async <T>(fn: () => T) => fn() } as unknown as Parameters<typeof startupDiagnostics>[0];

  test("a page whose bootstrap never ran: paths only, scripts in order, the boot guard's mark", async () => {
    install({
      href: "http://web.test/chan?room=r1&invite=n0nce",
      readyState: "complete",
      root: { "data-boot": "missing" },
      navigation: "navigate",
      scripts: [{ src: "/assets/index-Q.js?v=1", type: "module", async: true }, { text: BOOTSTRAP }],
    });
    const d = await startupDiagnostics(page, ["pageerror: Can't find variable: $_TSR at /chan?invite=n0nce"]);
    expect(d).toEqual({
      path: "/chan",
      readyState: "complete",
      navigationType: "navigate",
      hydrated: false,
      boot: "missing",
      bootstrap: "absent",
      players: 0,
      // Inline scripts by their first 60 characters only.
      scripts: ["module async /assets/index-Q.js", `classic inline (${BOOTSTRAP.slice(0, 60)}`],
      console: ["pageerror: Can't find variable: $_TSR at /chan?invite=REDACTED"],
    });
  });

  test("a hydrated page with its bootstrap and a player; no navigation entry", async () => {
    install({ root: { "data-hydrated": "" }, window: { $_TSR: {} }, players: 1, navigation: null });
    expect(await startupDiagnostics(page, [])).toMatchObject({
      hydrated: true,
      boot: null,
      bootstrap: "present",
      players: 1,
      navigationType: null,
      scripts: [],
    });
  });
});
