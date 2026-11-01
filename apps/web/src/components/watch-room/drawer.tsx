// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";

export interface WatchRoomDrawerProps {
  /** The channel whose broadcast the room watches. */
  channel: string;
  signedIn: boolean;
  selfUsername: string | null;
}

/**
 * The watch-room drawer in the chat panel (ADR 0017): create a room, copy the invite, the member
 * list and the room's side chat; the player follows the room through `player/room-sync*`. Stub
 * from the batch 7 contract step: W3-watch-rooms fills it (`apps/web/src/components/watch-room/**`).
 */
export function WatchRoomDrawer(_props: WatchRoomDrawerProps): React.JSX.Element | null {
  return null;
}
