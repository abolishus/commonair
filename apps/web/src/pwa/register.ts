// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Service worker registration and the update flow (ADR 0028 decision 7). A new build's worker
 * waits; the page offers a reload and only then asks it to take over, so nothing reloads under a
 * viewer mid-stream.
 */

export const SW_URL = "/sw.js";
export const SW_SCOPE = "/";
/** The message the worker answers with `skipWaiting()` (`src/sw/sw.ts`). */
export const SKIP_WAITING = { type: "skip-waiting" } as const;

/** OBS overlays and embeds run inside other software and sites: they never register a worker. */
export function pwaExcludedPath(pathname: string): boolean {
  return pathname.startsWith("/overlay/") || pathname.startsWith("/embed/");
}

/** The parts of `ServiceWorkerContainer` used here (a fake in tests). */
export interface WorkerContainer {
  readonly controller: unknown;
  register(url: string, options: { scope: string }): Promise<WorkerRegistration>;
  addEventListener(type: "controllerchange", listener: () => void, options?: { once: boolean }): void;
}

export interface WaitingWorker {
  readonly state: string;
  postMessage(message: unknown): void;
  addEventListener(type: "statechange", listener: () => void): void;
}

export interface WorkerRegistration {
  readonly waiting: WaitingWorker | null;
  readonly installing: WaitingWorker | null;
  addEventListener(type: "updatefound", listener: () => void): void;
}

/**
 * Register `/sw.js` and call `onUpdate` with a new worker once it is installed and waiting. The
 * first install of all is not an update (no page is controlled yet), so it is not reported.
 */
export async function registerServiceWorker(
  container: WorkerContainer,
  onUpdate: (worker: WaitingWorker) => void,
): Promise<WorkerRegistration> {
  const registration = await container.register(SW_URL, { scope: SW_SCOPE });
  if (registration.waiting && container.controller) onUpdate(registration.waiting);
  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && container.controller) onUpdate(worker);
    });
  });
  return registration;
}

/** The viewer chose to reload: let the waiting worker take over, then reload once it controls the page. */
export function applyUpdate(container: WorkerContainer, worker: WaitingWorker, reload: () => void): void {
  // Another tab already let it take over: `controllerchange` has fired here or never will.
  if (worker.state === "activating" || worker.state === "activated" || worker.state === "redundant") {
    reload();
    return;
  }
  container.addEventListener("controllerchange", reload, { once: true });
  worker.postMessage(SKIP_WAITING);
}

/** Run `fn` when the browser is idle (or soon, where `requestIdleCallback` is missing); returns a cancel. */
export function whenIdle(fn: () => void, timeoutMs = 5_000): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(fn, { timeout: timeoutMs });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(fn, 1_000);
  return () => window.clearTimeout(id);
}
