// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The EventSub WebSocket transport (ADR 0027 §3), served by the API at `EVENTSUB_WS_PATH`. Owned by
 * E9-ws; the contract step fixed these exported names and types (E9-subs codes against
 * `EventSubSessions`) and wired them into `main.ts` and `index.ts`. The hub is in `hub.ts`, the
 * Valkey session registry in `sessions.ts`, the pure protocol in `protocol.ts`.
 */
import type { Server, WebSocketHandler } from "bun";
import type { Deps } from "../deps.ts";
import { EVENTSUB_DEFAULTS, EventSubHub, type EventSubIo, type EventSubOptions } from "./hub.ts";
import { SessionStore } from "./sessions.ts";

export interface EventSubSocketData {
  sessionId: string;
  keepaliveSeconds: number;
  /** ISO 8601; the original connect time, kept across a resume. */
  connectedAt: string;
  /** Taken over from another instance with a resume token. */
  resumed: boolean;
  /** Set when a `resume` token did not resolve: the socket is closed with this code (4007) on open. */
  reject?: number;
}

export interface EventSub {
  websocket: WebSocketHandler<EventSubSocketData>;
  /** Upgrade `GET /eventsub/ws`; `undefined` once upgraded, a Response otherwise. */
  upgrade(req: Request, server: Server<EventSubSocketData>): Promise<Response | undefined>;
  /** True once the BUS subscribers listen (readiness). */
  readonly warm: boolean;
  /** Before shutdown: `session_reconnect` to every session, then wait out the grace. */
  drain(): Promise<void>;
}

export type { EventSubOptions } from "./hub.ts";
export { EventSubHub } from "./hub.ts";

const hubs = new WeakMap<Deps, EventSubHub>();

/**
 * Start the transport (BUS subscriber, keepalives, reload, sweep) and register
 * `process.once("SIGTERM" | "SIGINT", () => void drain())`: `main.ts` calls this before
 * `runService`, so the drain runs before runService's handlers stop the server. Tests pass options
 * (shorter timers, `handleSignals: false`); a hub already running for these deps is replaced.
 */
export function startEventSub(deps: Deps, opts: Partial<EventSubOptions> = {}, io?: Partial<EventSubIo>): EventSubHub {
  const old = hubs.get(deps);
  if (old) void old.close();
  const hub = new EventSubHub(
    deps,
    { ...EVENTSUB_DEFAULTS, ...opts },
    io?.connect ? { connect: io.connect } : undefined,
  );
  hubs.set(deps, hub);
  hub.start();
  return hub;
}

export function eventSub(deps: Deps): EventSubHub {
  return hubs.get(deps) ?? startEventSub(deps);
}

export async function closeEventSub(deps: Deps): Promise<void> {
  const hub = hubs.get(deps);
  hubs.delete(deps);
  await hub?.close();
}

/** Session lookups for `developer.events.subscribe` (E9-subs), implemented by E9-ws. */
export interface EventSubGrant {
  appId: string | null;
  userId: string;
  tokenHash: string;
}

export type BindResult = "ok" | "unknown_session" | "other_grant" | "too_many_sessions";

export interface EventSubSessions {
  /**
   * Bind an unbound session to this grant, or confirm it is already this grant's. The grant is
   * (appId, userId): a session bound with one access token accepts later subscriptions made with
   * any other token of the same grant (a refreshed one), and records the presented `tokenHash`.
   */
  bind(sessionId: string, grant: EventSubGrant): Promise<BindResult>;
}

const sessions = new WeakMap<Deps, EventSubSessions>();

/** The Valkey registry (any API instance can bind a session another one holds). */
export function eventSubSessions(deps: Deps): EventSubSessions {
  let s = sessions.get(deps);
  if (!s) {
    const store = new SessionStore(deps.valkey, () => deps.env.EVENTSUB_WS_MAX_SESSIONS_PER_GRANT);
    s = { bind: (sessionId, grant) => store.bind(sessionId, grant) };
    sessions.set(deps, s);
  }
  return s;
}

/** Tests install a fake. */
export function setEventSubSessions(deps: Deps, s: EventSubSessions): void {
  sessions.set(deps, s);
}
