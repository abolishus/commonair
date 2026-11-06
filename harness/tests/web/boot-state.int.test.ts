// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The in-page readers in a real Chromium page (served through a route, nothing on the network):
 * what `readBootState` and `startupDiagnostics` say about a document whose bootstrap ran, one whose
 * bootstrap never ran, and one an earlier hydration cleaned up.
 */
import { type Browser, type Page, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { startupDiagnostics } from "../../src/w3/watch-rooms/startup.ts";
import { type BootState, readBootState } from "../../src/web/hydration.ts";

const ORIGIN = "http://web.test";
const BOOTSTRAP = `<script data-tsr-stream-part="">(self.$R=self.$R||{})["tsr"]=[];self.$_TSR={h(){}};</script>`;
const CLEANUP = `<script>delete self.$R.tsr; delete self.$_TSR; document.documentElement.dataset.hydrated = "true";</script>`;
const ENTRY = `<script type="module" src="/assets/index-T3st.js"></script>`;

let browser: Browser;

// A cold Chromium launch on a loaded CI runner takes well over the default hook timeout.
beforeAll(async () => {
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function open(body: string, path = "/chan?room=r1&invite=n0nce"): Promise<Page> {
  const page = await browser.newPage();
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/assets/")) return route.fulfill({ contentType: "text/javascript", body: "" });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head></head><body>${body}</body></html>`,
    });
  });
  await page.goto(`${ORIGIN}${path}`);
  await page.waitForLoadState("load");
  return page;
}

/** Each test opens a page; generous, as CI runs these beside the other integration suites. */
const PAGE_MS = 60_000;

describe("in Chromium", () => {
  test(
    "a bootstrap that ran and is still there",
    async () => {
      const page = await open(`${BOOTSTRAP}${ENTRY}<div data-testid="player"></div>`);
      const state: BootState = await page.evaluate(readBootState);
      expect(state).toMatchObject({
        readyState: "complete",
        seroval: "object",
        serovalTsr: true,
        tsr: "object",
        hydrated: false,
        moduleScripts: ["/assets/index-T3st.js"],
        entryFetches: 1,
        navigationType: "navigate",
      });
      const d = await startupDiagnostics(page, []);
      expect(d).toMatchObject({ path: "/chan", bootstrap: "present", players: 1 });
      expect(d?.scripts[1]).toBe("module /assets/index-T3st.js");
      await page.close();
    },
    PAGE_MS,
  );

  test(
    "an earlier hydration cleaned up: $R stays without tsr, and the page says hydrated",
    async () => {
      const page = await open(`${BOOTSTRAP}${CLEANUP}`);
      expect(await page.evaluate(readBootState)).toMatchObject({
        seroval: "object",
        serovalTsr: false,
        tsr: "undefined",
        hydrated: true,
        moduleScripts: [],
      });
      expect(await startupDiagnostics(page, [])).toMatchObject({ hydrated: true, bootstrap: "absent" });
      await page.close();
    },
    PAGE_MS,
  );

  test(
    "a document that never carried the bootstrap",
    async () => {
      const page = await open(ENTRY);
      expect(await page.evaluate(readBootState)).toMatchObject({ seroval: "undefined", tsr: "undefined" });
      const d = await startupDiagnostics(page, ["pageerror: x at /chan?invite=n0nce"]);
      expect(d).toMatchObject({ path: "/chan", bootstrap: "absent", players: 0, boot: null });
      expect(d?.console).toEqual(["pageerror: x at /chan?invite=REDACTED"]);
      await page.close();
    },
    PAGE_MS,
  );

  test(
    "a closed page cannot be read: null, not a throw",
    async () => {
      const page = await open("");
      await page.close();
      expect(await startupDiagnostics(page, [])).toBeNull();
    },
    PAGE_MS,
  );
});
