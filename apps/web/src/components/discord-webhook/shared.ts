// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The studio's Discord webhook section (ADR 0028 decision 5): its client and pure helpers. */
import type { DISCORD_WEBHOOK_ERRORS } from "@commonair/contracts/enums";
import { DISCORD_WEBHOOK_URL } from "@commonair/contracts/notify";
import type { MessageKey } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";

export type DiscordWebhookError = (typeof DISCORD_WEBHOOK_ERRORS)[number];

export interface DiscordWebhookStatusDto {
  configured: boolean;
  setAt: string | null;
  lastPostedAt: string | null;
  lastError: DiscordWebhookError | null;
}

/** `notifications.discord.*` for one channel; tests pass a fake. */
export interface DiscordWebhookClient {
  get(): Promise<DiscordWebhookStatusDto>;
  set(url: string): Promise<DiscordWebhookStatusDto>;
  remove(): Promise<unknown>;
  test(): Promise<DiscordWebhookStatusDto>;
}

export const discordWebhookClient = (channel: string): DiscordWebhookClient => ({
  get: () => api().notifications.discord.get({ channel }),
  set: (url) => api().notifications.discord.set({ channel, url }),
  remove: () => api().notifications.discord.remove({ channel }),
  test: () => api().notifications.discord.test({ channel }),
});

/** The pasted URL, trimmed, when it is a Discord channel webhook; null otherwise (the server is authoritative). */
export function cleanWebhookUrl(raw: string): string | null {
  const url = raw.trim();
  return url.length <= 300 && DISCORD_WEBHOOK_URL.test(url) ? url : null;
}

export const ERROR_MESSAGE: Record<DiscordWebhookError, MessageKey> = {
  unauthorized: "discord.error.unauthorized",
  not_found: "discord.error.not_found",
  rate_limited: "discord.error.rate_limited",
  rejected: "discord.error.rejected",
  network: "discord.error.network",
};

/**
 * docs/streamers/discord.md in the source this instance runs. `sourceUrl` is `instance.info`'s
 * link: the repository, or `<repo>/tree/<commit>`.
 */
export function discordDocsUrl(sourceUrl: string | null): string | null {
  if (!sourceUrl) return null;
  const base = sourceUrl.replace(/\/+$/, "");
  const pinned = /^(.*)\/tree\/([^/]+)$/.exec(base);
  if (pinned?.[1] && pinned[2]) return `${pinned[1]}/blob/${pinned[2]}/docs/streamers/discord.md`;
  return `${base}/blob/HEAD/docs/streamers/discord.md`;
}
