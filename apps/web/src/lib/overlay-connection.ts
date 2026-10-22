// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The OBS alert overlay's connection (docs/testing/e6-selectors.md "Overlay page"): load
 * `interact.overlays.state` with the token, open an `EventSource` on its `eventsUrl`, hand each
 * `alert` frame to the queue. A `revoked` frame or a 401 from the state call ends it for good
 * (`refused`); anything else (a dropped stream, a network error, a 5xx) reconnects with backoff.
 *
 * An `EventSource` cannot tell a 401 from a network error, so every stream error closes the
 * stream and asks the state call again: its answer decides between refusing and retrying. The
 * token is never logged and never leaves this module except in the URL the API gave us.
 */
import { OverlayAlert } from "@commonair/contracts/dto";
import type { OverlayAlertItem, OverlayState } from "@commonair/ui/blocks/overlay";
import { backoffDelay } from "../chat/backoff.ts";
import { errorCode } from "./api.ts";

/** What the overlay needs of an `EventSource` (the browser's, or a fake in tests). */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

export interface OverlayConnectionDeps {
  /** `interact.overlays.state` with the token; rejects with the oRPC error. */
  loadState: () => Promise<{ eventsUrl: string }>;
  openEvents: (url: string) => EventSourceLike;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  random?: () => number;
}

export interface OverlayConnectionHandlers {
  onState: (state: OverlayState) => void;
  onAlert: (alert: OverlayAlertItem) => void;
}

/** Reconnect delays: 1 s doubling to 30 s, so a restarting API is not stampeded by every OBS. */
export const OVERLAY_BACKOFF = { baseMs: 1_000, maxMs: 30_000, jitter: 0.3 } as const;
/** The API pings every 15 s; this long without any frame means the stream silently died. */
export const OVERLAY_STALL_MS = 45_000;

/** An `alert` frame's data as the queue's item, or null when it does not parse. */
export function parseAlertFrame(data: unknown): OverlayAlertItem | null {
  if (typeof data !== "string") return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = OverlayAlert.safeParse(json);
  if (!parsed.success) return null;
  const a = parsed.data;
  return {
    id: a.id,
    type: a.type,
    text: a.text,
    message: a.message,
    amountCents: a.amountCents,
    durationMs: a.durationMs,
    animation: a.animation,
    test: a.test,
  };
}

/** Starts the connection; returns `stop`, which closes everything and schedules nothing more. */
export function connectOverlay(deps: OverlayConnectionDeps, handlers: OverlayConnectionHandlers): () => void {
  let stopped = false;
  let attempt = 0;
  let source: EventSourceLike | null = null;
  let retryTimer: unknown = null;
  let stallTimer: unknown = null;

  const clearTimer = (handle: unknown) => {
    if (handle !== null) deps.clearTimeout(handle);
  };
  const closeSource = () => {
    clearTimer(stallTimer);
    stallTimer = null;
    const open = source;
    source = null;
    open?.close();
  };
  const refuse = () => {
    if (stopped) return;
    stopped = true;
    clearTimer(retryTimer);
    retryTimer = null;
    closeSource();
    handlers.onState("refused");
  };
  const retryLater = () => {
    if (stopped) return;
    closeSource();
    handlers.onState("connecting");
    clearTimer(retryTimer);
    const delay = backoffDelay(attempt++, OVERLAY_BACKOFF, deps.random);
    retryTimer = deps.setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  };
  const armStall = (current: EventSourceLike) => {
    clearTimer(stallTimer);
    stallTimer = deps.setTimeout(() => {
      stallTimer = null;
      if (source === current) retryLater();
    }, OVERLAY_STALL_MS);
  };

  const open = (url: string) => {
    if (stopped) return;
    const current = deps.openEvents(url);
    source = current;
    // Frames from a stream we already dropped are ignored.
    const live = () => !stopped && source === current;
    armStall(current);
    current.addEventListener("open", () => {
      if (!live()) return;
      attempt = 0;
      armStall(current);
      handlers.onState("live");
    });
    current.addEventListener("ping", () => {
      if (live()) armStall(current);
    });
    current.addEventListener("alert", (event) => {
      if (!live()) return;
      armStall(current);
      const alert = parseAlertFrame(event.data);
      if (alert) handlers.onAlert(alert);
    });
    current.addEventListener("revoked", () => {
      if (live()) refuse();
    });
    current.addEventListener("error", () => {
      // Closed here so the browser's own reconnect cannot hide a 401; the state call decides.
      if (live()) retryLater();
    });
  };

  function connect(): void {
    if (stopped) return;
    deps
      .loadState()
      .then((state) => open(state.eventsUrl))
      .catch((err: unknown) => {
        if (errorCode(err) === "UNAUTHORIZED") refuse();
        else retryLater();
      });
  }

  handlers.onState("connecting");
  connect();
  return () => {
    stopped = true;
    clearTimer(retryTimer);
    retryTimer = null;
    closeSource();
  };
}
