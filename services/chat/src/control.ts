// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Messages on BUS.chatControl(channelId) and BUS.chat(channelId).
 *
 * Control: a client-visible ServerFrame (`ban`, `delete`, `clear`, `settings`) that every
 * instance forwards to its local members after updating its caches, or an `invalidate`
 * signal (role changes, unbans, emote/filter edits by the API) that only drops caches.
 *
 * CONTRACT-REQUEST: move `ChatControlMessage` and `ChatFanout` to packages/contracts/src/chat.ts
 * so services/api publishes the same shapes after REST moderation.
 */
import { z } from "zod";
import { ServerFrame } from "@commonair/contracts";

const frameOps = new Set(["ban", "delete", "clear", "settings"]);

export const InvalidateMessage = z.object({
  op: z.literal("invalidate"),
  /** `channel`: settings/emotes/filters/suspension; `user`: one user's roles/bans in the channel. */
  scope: z.enum(["channel", "user"]),
  userId: z.uuid().optional(),
});
export type InvalidateMessage = z.infer<typeof InvalidateMessage>;

export const ChatControlMessage = z.union([
  InvalidateMessage,
  ServerFrame.refine((f) => frameOps.has(f.op), "not a control frame"),
]);
export type ChatControlMessage = z.infer<typeof ChatControlMessage>;

/** Fan-out envelope on BUS.chat: the frame plus routing and timing metadata. */
export const ChatFanout = z.object({
  v: z.literal(1),
  /** "moderators" for messages held by a word filter. */
  audience: z.enum(["all", "moderators"]),
  /** Publish time (epoch ms) for the fan-out latency histogram. */
  sentAt: z.number(),
  frame: ServerFrame,
});
export type ChatFanout = z.infer<typeof ChatFanout>;

export function parseJson<T>(schema: z.ZodType<T>, raw: string): T | null {
  try {
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
