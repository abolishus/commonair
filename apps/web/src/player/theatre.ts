// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Theatre mode (D2-player owns it; the channel page lays out from it and chat sizes from it).
 * `TheatreProvider` keeps the choice per tab (`sessionStorage`, like the player's other per-tab
 * hints); the player's theatre button and the `t` key turn it on and off. In theatre mode chat
 * stays docked (decision (b)); `useTheatreChat()` is the bar's chat-collapse button, for a
 * full-width player.
 */
import * as React from "react";

export interface Theatre {
  theatre: boolean;
  setTheatre: (next: boolean) => void;
}

const OFF: Theatre = { theatre: false, setTheatre: () => {} };

export const TheatreContext = React.createContext<Theatre>(OFF);

/** Outside a `TheatreContext` provider theatre is off and cannot be turned on. */
export function useTheatre(): Theatre {
  return React.useContext(TheatreContext);
}

/**
 * Below Tailwind's `md` (48rem) the theatre button is hidden, so the `t` key and the `?` dialog
 * must not offer theatre there either: there would be no visible way back out.
 */
export const THEATRE_NARROW_QUERY = "(max-width: 47.99rem)";

function narrowQuery(): MediaQueryList | null {
  try {
    return typeof window.matchMedia === "function" ? window.matchMedia(THEATRE_NARROW_QUERY) : null;
  } catch {
    return null;
  }
}

function subscribeNarrow(cb: () => void): () => void {
  const q = narrowQuery();
  // Some environments (and tests) hand back a bare `{ matches }`.
  if (!q || typeof q.addEventListener !== "function") return () => {};
  q.addEventListener("change", cb);
  return () => q.removeEventListener("change", cb);
}

const readNarrow = () => narrowQuery()?.matches === true;
const serverWide = () => false;

/**
 * Whether theatre mode is on offer here: a provider is mounted (the page lays out from it) and the
 * viewport is at least `md`. The player hides its button and ignores `t` otherwise.
 */
export function useTheatreAvailable(): boolean {
  const provided = React.useContext(TheatreContext) !== OFF;
  const narrow = React.useSyncExternalStore(subscribeNarrow, readNarrow, serverWide);
  return provided && !narrow;
}

export interface TheatreChat {
  /** Theatre mode with chat collapsed: the player takes the full width. Always false outside theatre. */
  chatHidden: boolean;
  setChatHidden: (next: boolean) => void;
}

const CHAT_SHOWN: TheatreChat = { chatHidden: false, setChatHidden: () => {} };

export const TheatreChatContext = React.createContext<TheatreChat>(CHAT_SHOWN);

export function useTheatreChat(): TheatreChat {
  return React.useContext(TheatreChatContext);
}

/** `sessionStorage` keys: per tab, so a new tab starts out of theatre mode. */
export const THEATRE_STORAGE_KEY = "commonair:player-theatre";
export const THEATRE_CHAT_STORAGE_KEY = "commonair:player-theatre-chat";

type TabStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function tabStorage(): TabStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** A boolean kept in this tab: storage when it works, memory when it is blocked. */
function tabFlag(key: string) {
  let memory: boolean | null = null;
  const listeners = new Set<() => void>();
  const read = (): boolean => {
    if (memory !== null) return memory;
    try {
      return tabStorage()?.getItem(key) === "on";
    } catch {
      return false;
    }
  };
  const write = (on: boolean) => {
    try {
      const s = tabStorage();
      if (!s) throw new Error("no storage");
      if (on) s.setItem(key, "on");
      else s.removeItem(key);
      memory = null;
    } catch {
      memory = on;
    }
    for (const l of listeners) l();
  };
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  return { read, write, subscribe, reset: () => void (memory = null) };
}

const theatreFlag = tabFlag(THEATRE_STORAGE_KEY);
const chatFlag = tabFlag(THEATRE_CHAT_STORAGE_KEY);

/** Tests: forget the in-memory fallback. */
export function resetTheatreForTests(): void {
  theatreFlag.reset();
  chatFlag.reset();
}

const serverOff = () => false;

/** The page-level provider (the channel page mounts it): theatre on or off, kept for this tab. */
export function TheatreProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const theatre = React.useSyncExternalStore(theatreFlag.subscribe, theatreFlag.read, serverOff);
  const hidden = React.useSyncExternalStore(chatFlag.subscribe, chatFlag.read, serverOff);
  const value = React.useMemo<Theatre>(() => ({ theatre, setTheatre: theatreFlag.write }), [theatre]);
  const chat = React.useMemo<TheatreChat>(
    () => ({ chatHidden: theatre && hidden, setChatHidden: chatFlag.write }),
    [theatre, hidden],
  );
  return React.createElement(
    TheatreContext.Provider,
    { value },
    React.createElement(TheatreChatContext.Provider, { value: chat }, children),
  );
}
