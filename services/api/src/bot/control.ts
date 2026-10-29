// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Channel-bot control fan-out (`BUS.botControl`): tells every chat instance which part of a
 * channel's bot config to reload. Published after commit; a lost message is caught up by the
 * bot engine's cache TTL, so a failure is logged, never fatal.
 */
import { BotControlMessage } from "@commonair/contracts/chat";
import { BUS } from "@commonair/contracts/events";
import type { Deps } from "../deps.ts";

export async function publishBotControl(
  deps: Pick<Deps, "valkey" | "logger">,
  channelId: string,
  scope: BotControlMessage["scope"],
): Promise<void> {
  const message = BotControlMessage.parse({ channelId, scope });
  try {
    await deps.valkey.publish(BUS.botControl, JSON.stringify(message));
  } catch (err) {
    deps.logger.warn("bot control publish failed", { channelId, scope, err });
  }
}
