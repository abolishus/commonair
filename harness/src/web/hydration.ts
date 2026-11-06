// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Why a page never hydrated. TanStack Start's client reads `window.$_TSR`, which an inline
 * bootstrap script in the server's HTML defines and which is deleted once a hydration has finished
 * and the stream has ended. A hydration that finds it missing throws
 * `undefined is not an object (evaluating 't.t=new Map(…fromSerializable…)')` and the page stays
 * inert. These tell the cases apart: the document never carried the bootstrap, the entry module
 * ran ahead of it, or an earlier hydration in the same window already cleaned it up.
 */

/** A page error thrown by TanStack's client hydration finding no bootstrap data. */
export function isHydrationBootError(message: string): boolean {
  return message.includes("fromSerializable") || message.includes("$_TSR");
}

/** Where the bootstrap and the entry module sit in a served document (positions only, no content). */
export interface DocumentScriptOrder {
  bytes: number;
  /** Offset of `self.$_TSR={`, or -1. */
  bootstrapAt: number;
  /** Offset of the first `<script type="module"`, or -1. */
  entryAt: number;
  /** Inline `data-tsr-stream-part` scripts. */
  streamParts: number;
  /** The document ends with `</html>` (the stream was not cut). */
  complete: boolean;
}

export function documentScriptOrder(html: string): DocumentScriptOrder {
  return {
    bytes: html.length,
    bootstrapAt: html.indexOf("self.$_TSR={"),
    entryAt: html.search(/<script\b[^>]*\btype=["']?module\b/i),
    streamParts: html.match(/<script\b[^>]*\bdata-tsr-stream-part\b/gi)?.length ?? 0,
    complete: /<\/html>\s*$/i.test(html),
  };
}

/** The boot globals in the window when hydration failed (types and flags only). */
export interface BootState {
  readyState: string;
  /** `self.$R`: the bootstrap's first statement creates it, and cleanup leaves it behind. */
  seroval: string;
  /** `self.$R.tsr`, deleted with `$_TSR` by the cleanup. */
  serovalTsr: boolean;
  tsr: string;
  hydrated: boolean;
  serviceWorkerControls: boolean;
  /** Module scripts in the document, by path. */
  moduleScripts: string[];
  /** Times each entry module (`/assets/index-*.js`) was fetched. */
  entryFetches: number;
  navigationType: string;
}

/**
 * Runs in the page (`page.evaluate`): no closures over harness code. `seroval` defined while `tsr`
 * is not means the cleanup ran, so this window had hydrated once already; neither defined means
 * the bootstrap never ran here.
 */
export function readBootState(): BootState {
  const w = window as unknown as { $R?: Record<string, unknown>; $_TSR?: unknown };
  const moduleScripts = [...document.querySelectorAll<HTMLScriptElement>('script[type="module"]')].map((s) =>
    s.src ? new URL(s.src, location.href).pathname : "inline",
  );
  const entryFetches = performance
    .getEntriesByType("resource")
    .filter((e) => /\/assets\/index-[^/]*\.js$/.test(new URL(e.name, location.href).pathname)).length;
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return {
    readyState: document.readyState,
    seroval: typeof w.$R,
    serovalTsr: typeof w.$R === "object" && w.$R !== null && "tsr" in w.$R,
    tsr: typeof w.$_TSR,
    hydrated: document.documentElement.dataset.hydrated === "true",
    serviceWorkerControls: Boolean(navigator.serviceWorker?.controller),
    moduleScripts,
    entryFetches,
    navigationType: nav?.type ?? "unknown",
  };
}
