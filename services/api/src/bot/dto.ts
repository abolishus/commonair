// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Row → contract DTO mapping for the channel bot. */
import type { z } from "zod";
import type { dto } from "@commonair/contracts";
import { BotConfig } from "@commonair/contracts/shapes";
import type { schema } from "@commonair/db";

export type BotCommand = z.infer<typeof dto.BotCommand>;
export type BotTimer = z.infer<typeof dto.BotTimer>;
export type BotSettings = z.infer<typeof dto.BotSettings>;
export type SongRequest = z.infer<typeof dto.SongRequest>;

type CommandRow = typeof schema.botCommands.$inferSelect;
type TimerRow = typeof schema.botTimers.$inferSelect;
type SongRequestRow = typeof schema.songRequests.$inferSelect;

export const toBotCommand = (r: CommandRow): BotCommand => ({
  id: r.id,
  name: r.name,
  aliases: r.aliases,
  response: r.response,
  userLevel: r.userLevel,
  cooldownSeconds: r.cooldownSeconds,
  costPoints: r.costPoints,
  enabled: r.enabled,
  useCount: r.useCount,
});

export const toBotTimer = (r: TimerRow): BotTimer => ({
  id: r.id,
  name: r.name,
  message: r.message,
  intervalMinutes: r.intervalMinutes,
  minChatLines: r.minChatLines,
  enabled: r.enabled,
});

export const toSongRequest = (r: SongRequestRow, requester: string): SongRequest => ({
  id: r.id,
  url: r.url,
  requester,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
});

/** A stored config read through the current schema: defaults fill what older rows lack. */
export function readBotConfig(stored: unknown): BotConfig {
  const parsed = BotConfig.safeParse(stored ?? {});
  return parsed.success ? parsed.data : BotConfig.parse({});
}
