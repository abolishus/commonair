// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The server name in prefixes (`:tmi.twitch.tv 001 …`, `nick!nick@nick.tmi.twitch.tv`).
 * This is a protocol constant, not our domain: unmodified tmi.js routes server
 * lines by comparing the prefix to this exact string (and ignores 376/ROOMSTATE/
 * NOTICE/… from any other prefix), as do other Twitch IRC libraries. Using our
 * own host here would break the very clients this gateway exists for.
 */
export const SERVER_NAME = "tmi.twitch.tv";

/** Limits on what one IRC connection may do. */
export const LIMITS = {
  /** IRCv3 message-tags: the tag section may be up to 8191 bytes. */
  maxTagBytes: 8191,
  /** RFC 1459: 512 bytes including CRLF for everything after the tags. */
  maxLineBytes: 512,
  /**
   * Hard framing cap. PRIVMSG is measured like Twitch measures it (500 characters of
   * text, which can exceed 512 bytes in UTF-8 or with a long channel name), so the
   * framer accepts up to this much and the session applies the per-command limit.
   */
  maxFrameBytes: 8191 + 4096,
  maxChannels: 100,
  /** Token bucket for lines from the client: burst, then sustained per second. */
  rateBurst: 60,
  ratePerSecond: 10,
  /** Lines dropped by the rate limit within one window before we disconnect for flooding. */
  floodDisconnectAfter: 200,
  /** Outgoing bytes buffered for a client before it is disconnected as too slow. */
  maxBufferedBytes: 1024 * 1024,
  registrationTimeoutMs: 30_000,
  upstreamConnectTimeoutMs: 10_000,
  /** Send PING after this long without client traffic; disconnect after twice that. */
  idlePingMs: 240_000,
  pendingCommandTimeoutMs: 10_000,
} as const;
