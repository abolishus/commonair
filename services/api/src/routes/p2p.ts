// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** P2P playback (ADR 0005 amendment 1). P1-turn implements `iceServers`. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const p2p = {
  iceServers: os.p2p.iceServers.handler(() => notImplemented()),
};
