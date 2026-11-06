// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { documentScriptOrder, isHydrationBootError } from "../../src/web/hydration.ts";

describe("isHydrationBootError", () => {
  test("WebKit's message for the minified hydrate (watch-room b8 edge-sync, 42255758489)", () => {
    expect(
      isHydrationBootError(
        "TypeError: undefined is not an object (evaluating 't.t=new Map(n.map(e=>[e.key,e.fromSerializable]))')",
      ),
    ).toBe(true);
  });

  test("a development build's invariant", () => {
    expect(
      isHydrationBootError("Invariant failed: Expected to find bootstrap data on window.$_TSR, but we did not."),
    ).toBe(true);
  });

  test("other page errors are not", () => {
    expect(isHydrationBootError("ResizeObserver loop completed with undelivered notifications.")).toBe(false);
    expect(isHydrationBootError("")).toBe(false);
  });
});

// The shape of a page the web server renders (`/signin`), cut down.
const BOOTSTRAP = `<script data-tsr-stream-part="">(self.$R=self.$R||{})["tsr"]=[];self.$_TSR={h(){}};$_TSR.router=($R=>$R[0]={})($R["tsr"])</script>`;
const ENTRY = `<script type="module" async="" src="/assets/index-RYt2ndz2.js"></script>`;
const BOUNDARY = `<script>document.currentScript.remove();/*$tsr-stream-boundary*/</script>`;
const page = (body: string) =>
  `<!DOCTYPE html><html lang="en"><head><link rel="modulepreload" href="/assets/index-RYt2ndz2.js"/></head><body><main></main>${body}</body></html>`;

describe("documentScriptOrder", () => {
  test("a whole document: the bootstrap ahead of the entry module", () => {
    const html = page(BOOTSTRAP + ENTRY + BOUNDARY);
    const order = documentScriptOrder(html);
    expect(order.bytes).toBe(html.length);
    expect(order.bootstrapAt).toBeGreaterThan(0);
    expect(order.entryAt).toBeGreaterThan(order.bootstrapAt);
    expect(order.streamParts).toBe(1);
    expect(order.complete).toBe(true);
  });

  test("a modulepreload link is not the entry module", () => {
    const order = documentScriptOrder(page(BOOTSTRAP + BOUNDARY));
    expect(order.entryAt).toBe(-1);
  });

  test("a document without the bootstrap", () => {
    const order = documentScriptOrder(page(ENTRY));
    expect(order.bootstrapAt).toBe(-1);
    expect(order.entryAt).toBeGreaterThan(0);
    expect(order.streamParts).toBe(0);
  });

  test("a cut stream is not complete", () => {
    const html = page(BOOTSTRAP + ENTRY);
    expect(documentScriptOrder(html.slice(0, html.indexOf("</body>"))).complete).toBe(false);
    expect(documentScriptOrder(`${html}\n`).complete).toBe(true);
  });

  test("an empty body", () => {
    expect(documentScriptOrder("")).toEqual({
      bytes: 0,
      bootstrapAt: -1,
      entryAt: -1,
      streamParts: 0,
      complete: false,
    });
  });

  test("unquoted and upper-case attributes", () => {
    const order = documentScriptOrder(`<SCRIPT TYPE=module src="/assets/index-a.js"></SCRIPT></html>`);
    expect(order.entryAt).toBe(0);
    expect(order.complete).toBe(true);
  });
});
