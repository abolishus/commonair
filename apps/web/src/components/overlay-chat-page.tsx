// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Contract } from "@commonair/contracts";
import { ChatMessage } from "@commonair/ui/blocks/media";
import { type OverlayState, useReducedMotion } from "@commonair/ui/blocks/overlay";
import { cn } from "@commonair/ui/lib/utils";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import * as React from "react";
import { ChatConnection, type ChatDeps, type ChatMessageFrame, type ChatStatus } from "../chat/connection.ts";
import { nameColorIndex, visibleBadges } from "../chat/view.ts";
import { overlayApi } from "../lib/api.ts";
import { type OverlayConnectionDeps, connectOverlay } from "../lib/overlay-connection.ts";
import { overlayTokenFrom } from "../lib/overlay-page.ts";

/** The chat overlay keeps this many messages; older ones scroll off. */
export const OVERLAY_CHAT_MAX = 30;
/** A message fades out after a minute on screen… */
export const OVERLAY_CHAT_FADE_MS = 60_000;
/** …and is gone once the fade has run (at once with reduced motion). */
export const OVERLAY_CHAT_FADE_DURATION_MS = 1_000;

export interface OverlayChatLine {
  message: ChatMessageFrame;
  /** When it arrived (ms epoch); the fade counts from here. */
  at: number;
}

export type OverlayChatAction =
  | { type: "message"; message: ChatMessageFrame; now: number }
  | { type: "delete"; messageId: string }
  | { type: "ban"; userId: string }
  | { type: "clear" }
  | { type: "expire"; now: number; reducedMotion: boolean };

/**
 * The overlay's lines: newest last, at most `OVERLAY_CHAT_MAX`, duplicates ignored; a deleted
 * message, a banned user's messages and a cleared chat leave at once (no "message deleted"
 * placeholder on stream). Pure.
 */
export function overlayChatReducer(lines: OverlayChatLine[], action: OverlayChatAction): OverlayChatLine[] {
  switch (action.type) {
    case "message": {
      if (lines.some((l) => l.message.id === action.message.id)) return lines;
      const next = [...lines, { message: action.message, at: action.now }];
      return next.length > OVERLAY_CHAT_MAX ? next.slice(next.length - OVERLAY_CHAT_MAX) : next;
    }
    case "delete":
      return lines.filter((l) => l.message.id !== action.messageId);
    case "ban":
      return lines.filter((l) => l.message.user.id !== action.userId);
    case "clear":
      return [];
    case "expire": {
      const life = OVERLAY_CHAT_FADE_MS + (action.reducedMotion ? 0 : OVERLAY_CHAT_FADE_DURATION_MS);
      const kept = lines.filter((l) => action.now - l.at < life);
      return kept.length === lines.length ? lines : kept;
    }
  }
}

/** Fading: past the minute, before it is removed. */
export function isFading(line: OverlayChatLine, now: number): boolean {
  return now - line.at >= OVERLAY_CHAT_FADE_MS;
}

type ChatOverlayState = { eventsUrl: string; channelSlug: string };

export interface OverlayChatDeps {
  overlay: OverlayConnectionDeps<ChatOverlayState>;
  /** The chat WebSocket, joined as an anonymous reader. */
  chat: ChatDeps;
}

/**
 * Chat tokens for the overlay: same-origin, no cookies and no referrer, so the overlay reads chat
 * anonymously and never as whoever is signed in to the browser it runs in.
 */
function anonymousChatDeps(): ChatDeps {
  const client: ContractRouterClient<Contract> = createORPCClient(
    new RPCLink({
      url: () => `${window.location.origin}/rpc`,
      fetch: (request, init) => fetch(request, { ...init, credentials: "omit", referrerPolicy: "no-referrer" }),
    }),
  );
  return { getToken: () => client.chat.connectToken(), createSocket: (url) => new WebSocket(url) };
}

export function browserOverlayChatDeps(token: string): OverlayChatDeps {
  const client = overlayApi(token);
  return {
    overlay: {
      loadState: () => client.interact.overlays.state(),
      openEvents: (url) => new EventSource(url),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    },
    chat: anonymousChatDeps(),
  };
}

function withoutToken(): OverlayChatDeps {
  return {
    overlay: {
      loadState: () => Promise.reject(Object.assign(new Error("no overlay token"), { code: "UNAUTHORIZED" })),
      openEvents: () => {
        throw new Error("no overlay token");
      },
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    },
    chat: {
      getToken: () => Promise.reject(new Error("no overlay token")),
      createSocket: () => {
        throw new Error("no overlay token");
      },
    },
  };
}

const noop = () => {};

/**
 * `/overlay/chat`: the channel's chat, read-only and transparent, for OBS. The overlay token
 * names the channel (`interact.overlays.state`) and its stream says when the token is revoked;
 * the messages come from the chat WebSocket as an anonymous reader. Held messages never reach
 * it, deletions, bans and clears apply at once, the last 30 messages stay, each fading after a
 * minute. No input, no avatars.
 */
export function OverlayChatPage({
  deps = browserOverlayChatDeps,
  reducedMotion: reducedProp,
}: {
  deps?: (token: string) => OverlayChatDeps;
  reducedMotion?: boolean;
}): React.JSX.Element {
  const prefersReduced = useReducedMotion();
  const reducedMotion = reducedProp ?? prefersReduced;
  const [state, setState] = React.useState<OverlayState>("connecting");
  const [channel, setChannel] = React.useState<string | null>(null);
  // `data-state` follows the token (selectors spec); the chat socket is reported beside it.
  const [chatStatus, setChatStatus] = React.useState<ChatStatus>("closed");
  const [lines, dispatch] = React.useReducer(overlayChatReducer, []);
  const [now, setNow] = React.useState(() => Date.now());
  const made = React.useRef<OverlayChatDeps | null>(null);
  const makeDeps = React.useRef(deps);

  React.useEffect(() => {
    const token = overlayTokenFrom(window.location.search);
    const d = token ? makeDeps.current(token) : withoutToken();
    made.current = d;
    return connectOverlay(d.overlay, { onState: setState, onLoaded: (s) => setChannel(s.channelSlug) });
  }, []);

  const refused = state === "refused";
  React.useEffect(() => {
    const d = made.current;
    if (!d || channel === null || refused) return;
    const conn = new ChatConnection(channel, d.chat, {
      onStatus: setChatStatus,
      onJoined: noop,
      onMessage: (message) => dispatch({ type: "message", message, now: Date.now() }),
      onDelete: (messageId) => dispatch({ type: "delete", messageId }),
      onClear: () => dispatch({ type: "clear" }),
      onBan: (userId) => dispatch({ type: "ban", userId }),
      onNotice: noop,
    });
    conn.start();
    return () => {
      conn.stop();
      setChatStatus("closed");
    };
  }, [channel, refused]);

  React.useEffect(() => {
    if (state === "refused") dispatch({ type: "clear" });
  }, [state]);

  // One clock for the fade while anything is on screen.
  const any = lines.length > 0;
  React.useEffect(() => {
    if (!any) return;
    const timer = window.setInterval(() => {
      const at = Date.now();
      setNow(at);
      dispatch({ type: "expire", now: at, reducedMotion });
    }, 500);
    return () => window.clearInterval(timer);
  }, [any, reducedMotion]);

  const shown = refused ? [] : lines;
  return (
    <div
      data-testid="overlay-chat"
      data-state={state === "connecting" ? "loading" : state}
      data-chat={chatStatus}
      data-motion={reducedMotion ? "reduced" : "full"}
      className="pointer-events-none flex min-h-svh w-full flex-col justify-end gap-1 bg-transparent p-4 text-base text-overlay-foreground select-none"
    >
      {shown.map((line) => {
        const { message } = line;
        const fading = !reducedMotion && isFading(line, now);
        return (
          <ChatMessage
            key={message.id}
            data-testid="overlay-chat-message"
            data-id={message.id}
            data-username={message.user.username}
            data-fading={fading ? "true" : undefined}
            author={message.user.displayName}
            colorIndex={nameColorIndex(message.user.username)}
            badges={visibleBadges(message.user.badges)}
            body={message.body}
            action={message.isAction}
            className={cn(
              "font-medium text-shadow-md text-shadow-overlay",
              !reducedMotion && "transition-opacity duration-1000",
              fading && "opacity-0",
            )}
          />
        );
      })}
    </div>
  );
}
