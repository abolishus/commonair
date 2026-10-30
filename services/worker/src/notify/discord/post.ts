// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One POST to a Discord channel webhook (ADR 0028 decision 5) through the pinned SSRF guard. The
 * URL is a secret: it is never logged or returned, only sent.
 */
import { DISCORD_WEBHOOK_URL } from "@commonair/contracts/notify";
import { postPinned, type PostOptions } from "../../webhooks/http.ts";
import { classifyDiscordResult, type DiscordOutcome } from "./outcome.ts";
import type { DiscordMessage } from "./text.ts";

export const DISCORD_TIMEOUT_MS = 10_000;
export const DISCORD_MAX_RESPONSE_BYTES = 4096;
export const DISCORD_USER_AGENT = "CommonAir-Notify/1";

/**
 * How the POST reaches Discord. The registered job always passes `{ allowInsecure: false,
 * resolve: ctx.webhooks.resolve }`. Only tests pass anything else: a loopback receiver needs
 * `allowInsecure` (the guard refuses loopback otherwise), its CA and, since it cannot listen on
 * 443, `port`. The host can still only be Discord's: the URL is checked against
 * `DISCORD_WEBHOOK_URL` before any of this applies.
 */
export type DiscordTransport = Pick<PostOptions, "allowInsecure" | "resolve" | "ca"> & { port?: number };

/** POST `message`; a URL that is not a Discord webhook is `blocked` without a connection. */
export async function postDiscord(
  url: string,
  message: DiscordMessage,
  transport: DiscordTransport,
): Promise<DiscordOutcome> {
  // Defence in depth: the API checked it on `set`, but the row is the worker's input.
  if (!DISCORD_WEBHOOK_URL.test(url)) return { kind: "blocked" };
  const target = new URL(url);
  if (transport.port !== undefined) target.port = String(transport.port);
  // `wait=false`: Discord answers 204 without echoing the message back.
  target.search = "?wait=false";
  const { port: _port, ...pinned } = transport;
  const result = await postPinned(
    target.toString(),
    { body: JSON.stringify(message), contentType: "application/json", userAgent: DISCORD_USER_AGENT, headers: {} },
    { ...pinned, timeoutMs: DISCORD_TIMEOUT_MS, maxResponseBytes: DISCORD_MAX_RESPONSE_BYTES },
  );
  return classifyDiscordResult(result);
}
