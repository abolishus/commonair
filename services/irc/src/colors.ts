// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat color tokens → hex for the IRC `color` tag. The web client renders
 * tokens through theme variables (so contrast stays AA); IRC clients only
 * understand `#RRGGBB`, so this is the one place a fixed palette lives.
 * The hexes are Twitch's default name colors, which bots already expect.
 */
export const CHAT_COLOR_HEX: Readonly<Record<string, string>> = {
  "chat-1": "#FF0000",
  "chat-2": "#0000FF",
  "chat-3": "#008000",
  "chat-4": "#B22222",
  "chat-5": "#FF7F50",
  "chat-6": "#9ACD32",
  "chat-7": "#FF4500",
  "chat-8": "#2E8B57",
  "chat-9": "#DAA520",
  "chat-10": "#D2691E",
  "chat-11": "#5F9EA0",
  "chat-12": "#1E90FF",
};

/** Hex for a color token; a literal `#rrggbb` passes through; unknown or unset → "" (Twitch's "no color"). */
export function colorTag(token: string | null | undefined): string {
  if (!token) return "";
  const mapped = CHAT_COLOR_HEX[token];
  if (mapped) return mapped;
  return /^#[0-9a-f]{6}$/i.test(token) ? token.toUpperCase() : "";
}
