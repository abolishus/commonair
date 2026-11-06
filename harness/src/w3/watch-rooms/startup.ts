// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Start-up diagnostics for a member page whose player never played: whether the page hydrated,
 * whether TanStack's bootstrap (`window.$_TSR`) is there, the order of its scripts and its recent
 * console, folded into the step's error so the report carries them. WebKit members in CI have
 * thrown `undefined is not an object (evaluating 't.t=new Map(n.map(e=>[e.key,e.fromSerializable]))')`
 * at start-up (hydration reading a missing `$_TSR`) and never mounted a player (runs 41922495854
 * attempt 3, 42134001057, 42215129857); this tells the next one apart: bootstrap never set (its
 * inline scripts would also throw `Can't find variable: $_TSR`) or deleted by an earlier
 * hydration (they would not). Nothing personal: paths, no query strings, no tokens.
 */
import type { Page } from "playwright";
import { redactUrlSecrets } from "../../redact.ts";

/** Console lines kept per page, and how much of each. */
export const CONSOLE_KEEP = 20;
export const CONSOLE_CHARS = 200;
/** Inline scripts are named by their first characters. */
const INLINE_CHARS = 60;

/** What the page reports about itself (`readStartup`, evaluated in the page). */
export interface StartupRaw {
  path: string;
  readyState: string;
  navigationType: string | null;
  hydrated: boolean;
  /** `<html data-boot>`, set by the web app's hydration guard on a missing bootstrap. */
  boot: string | null;
  bootstrap: "present" | "absent";
  players: number;
  scripts: { src: string | null; type: string; async: boolean; inline: string | null }[];
}

export interface StartupDiagnostics extends Omit<StartupRaw, "scripts"> {
  /** In document order: `module async /assets/index-….js`, `inline (self.$R=…`. */
  scripts: string[];
  console: string[];
}

/** Query strings may carry an invite nonce or a token: keep the path only. */
function pathOnly(url: string): string {
  try {
    return new URL(url, "http://x").pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? "";
  }
}

function scrub(text: string): string {
  return redactUrlSecrets(text).replace(/([?&]invite=)[^&\s"'<>)]*/gi, "$1REDACTED");
}

/** A bounded console buffer: the last `CONSOLE_KEEP` lines, each cut to `CONSOLE_CHARS`, scrubbed. */
export function consoleBuffer(): { push(line: string): void; lines(): string[] } {
  const kept: string[] = [];
  return {
    push(line) {
      kept.push(scrub(line).slice(0, CONSOLE_CHARS));
      if (kept.length > CONSOLE_KEEP) kept.splice(0, kept.length - CONSOLE_KEEP);
    },
    lines: () => [...kept],
  };
}

/** Fold what the page reported and its console into the diagnostics the report shows. */
export function summarizeStartup(raw: StartupRaw, consoleLines: readonly string[]): StartupDiagnostics {
  const scripts = raw.scripts.map((s) => {
    const kind = [s.type || "classic", s.async ? "async" : ""].filter(Boolean).join(" ");
    return s.src !== null
      ? `${kind} ${pathOnly(s.src)}`
      : `${kind} inline (${scrub(s.inline ?? "").slice(0, INLINE_CHARS)}`;
  });
  return { ...raw, path: pathOnly(raw.path), scripts, console: consoleLines.map(scrub) };
}

/**
 * Runs in the page: plain DOM reads only, and no closure (Playwright sends the source), hence the
 * literal `INLINE_CHARS`. TanStack's inline bootstrap scripts remove themselves once run, so only
 * `bootstrap` and the console tell whether `$_TSR` was ever set.
 */
function readStartup(): StartupRaw {
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const root = document.documentElement;
  return {
    path: location.pathname,
    readyState: document.readyState,
    navigationType: nav?.type ?? null,
    hydrated: root.hasAttribute("data-hydrated"),
    boot: root.getAttribute("data-boot"),
    bootstrap: Reflect.get(window, "$_TSR") === undefined ? "absent" : "present",
    players: document.querySelectorAll('[data-testid="player"]').length,
    scripts: Array.from(document.scripts, (s) => ({
      src: s.getAttribute("src"),
      type: s.type,
      async: s.async,
      inline: s.src ? null : (s.textContent ?? "").slice(0, 60),
    })),
  };
}

/** How long the page gets to answer: `page.evaluate` has no timeout of its own. */
export const STARTUP_READ_TIMEOUT_MS = 5_000;

/**
 * Read the page's start-up state; null when the page cannot be read (closed, navigating, or not
 * answering within `timeoutMs`: a wedged page must not turn the step's timeout into a hang).
 */
export async function startupDiagnostics(
  page: Pick<Page, "evaluate">,
  consoleLines: readonly string[],
  timeoutMs = STARTUP_READ_TIMEOUT_MS,
): Promise<StartupDiagnostics | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const raw = await Promise.race([page.evaluate(readStartup), timedOut]);
    return raw === null ? null : summarizeStartup(raw, consoleLines);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The step's error with the diagnostics appended (the report shows step errors verbatim). */
export function withStartup(err: unknown, diagnostics: StartupDiagnostics | null): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`${message}\nstart-up: ${diagnostics ? JSON.stringify(diagnostics) : "unreadable"}`, {
    cause: err,
  });
}
