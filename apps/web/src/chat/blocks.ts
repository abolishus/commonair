// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The live-chat block set (ADR 0012 amendment 1 decision 8): the ids of the users the signed-in
 * viewer blocked, loaded once per page from `me.blocks.ids` and changed at once by a block or an
 * unblock made in this tab (the chat menu, `/settings/privacy`). Messages from these users are not
 * rendered, never counted in waves or the digest. One store per page, shared by every chat panel.
 */
import * as React from "react";
import { api } from "../lib/api.ts";

export interface BlocksClient {
  ids(): Promise<{ userIds: string[] }>;
  add(username: string): Promise<{ user: { id: string; username: string; displayName: string } }>;
  remove(username: string): Promise<unknown>;
}

// Inside `then`, so a client that cannot reach the API rejects instead of throwing.
export const blocksClient = (): BlocksClient => ({
  ids: () => Promise.resolve().then(() => api().me.blocks.ids()),
  add: (username) => Promise.resolve().then(() => api().me.blocks.add({ username })),
  remove: (username) => Promise.resolve().then(() => api().me.blocks.remove({ username })),
});

export interface BlockSet {
  ids: ReadonlySet<string>;
  /** Usernames of blocked users this page knows (for replies that quote them). */
  usernames: ReadonlySet<string>;
}

const EMPTY: BlockSet = Object.freeze({ ids: new Set<string>(), usernames: new Set<string>() });

let state: BlockSet = EMPTY;
let loading: Promise<void> | null = null;
let loadedFor: string | null = null;
const listeners = new Set<() => void>();

function set(next: BlockSet): void {
  state = next;
  for (const fn of listeners) fn();
}

export function blockSnapshot(): BlockSet {
  return state;
}

export function subscribeBlocks(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Loads the set for `viewer` once per page (again after a failure or for another viewer). */
export function loadBlocks(viewer: string, client: BlocksClient = blocksClient()): Promise<void> {
  if (loadedFor === viewer && loading) return loading;
  loadedFor = viewer;
  const attempt: Promise<void> = Promise.resolve()
    .then(() => client.ids())
    .then(({ userIds }) => {
      if (loadedFor !== viewer) return;
      // Blocks made while the list loaded stay.
      set({ ids: new Set([...userIds, ...state.ids]), usernames: state.usernames });
    })
    .catch(() => {
      // Chat still works without the list; the next mount tries again.
      if (loading === attempt) loading = null;
    });
  loading = attempt;
  return attempt;
}

/** A block made in this tab: hide the user at once. */
export function noteBlocked(user: { id: string; username: string }): void {
  if (state.ids.has(user.id) && state.usernames.has(user.username)) return;
  set({ ids: new Set([...state.ids, user.id]), usernames: new Set([...state.usernames, user.username]) });
}

/** An unblock made in this tab: show the user's next messages (and the ones still in the log). */
export function noteUnblocked(user: { id: string; username: string }): void {
  if (!state.ids.has(user.id) && !state.usernames.has(user.username)) return;
  const ids = new Set(state.ids);
  ids.delete(user.id);
  const usernames = new Set(state.usernames);
  usernames.delete(user.username);
  set({ ids, usernames });
}

/** Signed out, or another account: forget the set. Tests also use it between cases. */
export function resetBlocks(): void {
  loading = null;
  loadedFor = null;
  set(EMPTY);
}

/** The block set for the signed-in viewer (empty signed out). */
export function useBlocks(viewer: string | null, client?: BlocksClient): BlockSet {
  React.useEffect(() => {
    if (viewer) void loadBlocks(viewer, client);
    else if (loadedFor !== null) resetBlocks();
  }, [viewer, client]);
  return React.useSyncExternalStore(subscribeBlocks, blockSnapshot, () => EMPTY);
}
