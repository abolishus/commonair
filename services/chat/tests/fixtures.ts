// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Builders for unit tests. */
import { ChannelChatSettings } from "@commonair/contracts";
import { createLogger } from "@commonair/observability";
import { compileFilters } from "../src/content.ts";
import { MemoryLimiter } from "../src/limiter.ts";
import type { MessageMiddleware, PipelineInput } from "../src/pipeline.ts";
import {
  type ChannelState,
  type EmoteDef,
  NO_STANDING,
  type Standing,
  type UserProfile,
  type WordFilterDef,
} from "../src/types.ts";

export const NOW = new Date("2026-10-18T12:00:00Z");
export const silentLogger = createLogger({ service: "chat-test", write: () => {} });

export const user = (over: Partial<UserProfile> = {}): UserProfile => ({
  id: "00000000-0000-7000-8000-000000000001",
  username: "alice",
  displayName: "Alice",
  accountType: "human",
  platformRole: "user",
  emailVerified: true,
  createdAt: new Date(NOW.getTime() - 365 * 86_400_000),
  banned: false,
  banExpires: null,
  deleted: false,
  isMember: false,
  ...over,
});

export const emote = (code: string, tier = 0, id = `e-${code}`): EmoteDef => ({ id, code, tier, channelId: null });

export const channel = (
  settings: Partial<ChannelChatSettings> = {},
  over: Partial<ChannelState> = {},
): ChannelState => ({
  id: "00000000-0000-7000-8000-0000000000c1",
  slug: "streamer",
  ownerId: "00000000-0000-7000-8000-0000000000b1",
  displayName: "Streamer",
  settings: ChannelChatSettings.parse({ requireVerifiedEmail: false, ...settings }),
  suspended: false,
  liveBroadcastId: null,
  emotes: new Map([
    ["Kappa", emote("Kappa")],
    ["SubHype", emote("SubHype", 2)],
  ]),
  filters: [],
  ...over,
});

export const standing = (over: Partial<Standing> = {}): Standing => ({ ...NO_STANDING, ...over });

export function input(over: Partial<PipelineInput> & { filterDefs?: WordFilterDef[] } = {}): PipelineInput {
  const { filterDefs, ...rest } = over;
  return {
    messageId: "00000000-0000-7000-8000-00000000aaaa",
    receivedAt: NOW,
    user: user(),
    scopes: ["chat:read", "chat:edit"],
    viaAppId: null,
    channel: channel(),
    filters: compileFilters(filterDefs ?? []),
    standing: standing(),
    body: "hello world",
    isAction: false,
    replyToId: null,
    logger: silentLogger,
    ...rest,
  };
}

export const deps = (middlewares: MessageMiddleware[] = [], limiter = new MemoryLimiter(() => NOW.getTime())) => ({
  limiter,
  middlewares,
});
