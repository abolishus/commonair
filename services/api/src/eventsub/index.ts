// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The EventSub WebSocket transport (ADR 0027 §3), served by the API at `EVENTSUB_WS_PATH`. Owned by
 * E9-ws; the contract step fixed these exported names and types (E9-subs codes against
 * `EventSubSessions`) and wired the stub into `main.ts` and `index.ts`.
 */
import type { Server, WebSocketHandler } from "bun";
import type { Deps } from "../deps.ts";

export interface EventSubSocketData {
  sessionId: string /* E9-ws extends */;
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

const hubs = new WeakMap<Deps, EventSub>();

function stub(): EventSub {
  return {
    websocket: { message() {} },
    async upgrade() {
      return Response.json(
        { error: "eventsub_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    },
    warm: true,
    async drain() {},
  };
}

/**
 * Start the transport (BUS subscribers, keepalives). E9-ws registers its own
 * `process.once("SIGTERM" | "SIGINT", () => void drain())` here: `main.ts` calls this before
 * `runService`, so the drain runs before runService's handlers stop the server. The stub
 * registers nothing.
 */
export function startEventSub(deps: Deps): EventSub {
  const hub = stub();
  hubs.set(deps, hub);
  return hub;
}

export function eventSub(deps: Deps): EventSub {
  return hubs.get(deps) ?? startEventSub(deps);
}

export async function closeEventSub(deps: Deps): Promise<void> {
  hubs.delete(deps);
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

export function eventSubSessions(deps: Deps): EventSubSessions {
  return sessions.get(deps) ?? { bind: async () => "unknown_session" };
}

/** Tests install a fake. */
export function setEventSubSessions(deps: Deps, s: EventSubSessions): void {
  sessions.set(deps, s);
}
