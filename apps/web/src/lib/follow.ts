// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Follow state of one channel page: optimistic toggle with rollback. Pure reducer plus a
 * `toggleFollow` driver with the API call and clock injected, so both are unit-testable.
 */

export interface FollowState {
  /** null = unknown (anonymous, or the API did not say); treated as "not following" on toggle. */
  following: boolean | null;
  count: number;
  pending: boolean;
  /** What to restore if the in-flight request fails. */
  previous: { following: boolean | null; count: number } | null;
  /**
   * When the last toggle settled (ms clock). A `channels.get` poll requested at or before this
   * may have read the pre-toggle state, so its result is dropped.
   */
  settledAt: number;
}

export type FollowAction =
  /** `requestedAt`: when the poll that produced these values started (0 for the SSR snapshot). */
  | { type: "sync"; following: boolean | null; count: number; requestedAt: number }
  | { type: "start" }
  | { type: "success"; following: boolean; count: number; at: number }
  | { type: "failure"; at: number };

export function initialFollowState(following: boolean | null, count: number): FollowState {
  return { following, count, pending: false, previous: null, settledAt: 0 };
}

export function followReducer(state: FollowState, action: FollowAction): FollowState {
  switch (action.type) {
    case "sync":
      // A poll that raced an in-flight or just-settled toggle must not undo it.
      if (state.pending || action.requestedAt <= state.settledAt) return state;
      return { ...state, following: action.following ?? state.following, count: action.count };
    case "start": {
      if (state.pending) return state;
      const target = state.following !== true;
      return {
        following: target,
        count: Math.max(0, state.count + (target ? 1 : -1)),
        pending: true,
        previous: { following: state.following, count: state.count },
        settledAt: state.settledAt,
      };
    }
    case "success":
      return { following: action.following, count: action.count, pending: false, previous: null, settledAt: action.at };
    case "failure":
      if (!state.previous) return { ...state, pending: false, settledAt: action.at };
      return { ...state.previous, pending: false, previous: null, settledAt: action.at };
  }
}

export type FollowCall = (follow: boolean) => Promise<{ following: boolean; followerCount: number }>;

/** Run one toggle: optimistic `start`, then `success` or rollback + `onError`. No-op while pending. */
export async function toggleFollow(
  state: FollowState,
  call: FollowCall,
  dispatch: (action: FollowAction) => void,
  onError: (err: unknown) => void,
  now: () => number = Date.now,
): Promise<void> {
  if (state.pending) return;
  const target = state.following !== true;
  dispatch({ type: "start" });
  try {
    const res = await call(target);
    dispatch({ type: "success", following: res.following, count: res.followerCount, at: now() });
  } catch (err) {
    dispatch({ type: "failure", at: now() });
    onError(err);
  }
}
