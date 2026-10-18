// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat control fan-out (BUS.chatControl): frames are ServerFrame-shaped so chat and
 * IRC instances can forward them as-is; any frame also invalidates their cached
 * channel state. Changes without a dedicated frame use `op: "event"` (type
 * `unban`, `roles`, `filters`, `emotes`). Published after the transaction commits.
 */
import { ServerFrame } from "@commonair/contracts/chat";
import { BUS } from "@commonair/contracts/events";
import type { LiveEvent } from "@commonair/contracts/internal";
import type { Deps } from "../deps.ts";

export async function publishControl(deps: Deps, channelId: string, frame: ServerFrame): Promise<void> {
  const parsed = ServerFrame.parse(frame);
  try {
    await deps.valkey.publish(BUS.chatControl(channelId), JSON.stringify(parsed));
  } catch (err) {
    // The database is the source of truth; chat re-reads it on its next cache miss.
    deps.logger.warn("chat control publish failed", { channelId, op: parsed.op, err });
  }
}

export async function publishLive(deps: Deps, event: LiveEvent): Promise<void> {
  try {
    await deps.valkey.publish(BUS.live, JSON.stringify(event));
  } catch (err) {
    deps.logger.warn("live event publish failed", { channelId: event.channelId, type: event.type, err });
  }
}
