// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The first stream's share prompt (overhaul wave 5, J2-e), pure: it shows while the channel is
 * live for the first time (no stream of it has ever ended, so `lastLiveAt` is still null) and the
 * owner has not dismissed it for that channel. Once the first stream ends `lastLiveAt` is set and
 * it never shows again. Dismissing is remembered in this browser only (`localStorage`, guarded: a
 * private window that loses it shows the prompt once more, nothing worse).
 */
import { readFlag, writeFlag } from "../recap/model.ts";

export const SHARE_PROMPT_DISMISSED_KEY = "commonair.studio.sharePromptDismissed.v1";

export const sharePromptKey = (channel: string) => `${SHARE_PROMPT_DISMISSED_KEY}:${channel}`;

export function sharePromptVisible(input: {
  /** The channel's live broadcast is on (`Channel.live`); a rehearsal never sets it. */
  live: boolean;
  lastLiveAt: string | null;
  dismissed: boolean;
}): boolean {
  return input.live && input.lastLiveAt === null && !input.dismissed;
}

export const sharePromptDismissed = (channel: string): boolean => readFlag(sharePromptKey(channel)) !== null;

export const dismissSharePrompt = (channel: string): void => writeFlag(sharePromptKey(channel), "1");

/** The channel page's address: the studio is served from the same origin as the channel. */
export function channelLink(origin: string, channel: string): string {
  return `${origin.replace(/\/+$/, "")}/${encodeURIComponent(channel)}`;
}

/** What the Web Share API needs; absent in most desktop browsers. */
export type ShareFn = (data: { title?: string; text?: string; url?: string }) => Promise<void>;

export function webShare(nav: Partial<Pick<Navigator, "share">> | undefined): ShareFn | null {
  const share = nav?.share;
  return typeof share === "function" ? (data) => share.call(nav, data) : null;
}
