// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The chat column's size classes (the channel page applies them to `ChatPanel` and its pending
 * skeleton). Design review F6: chat fills the column beside the player.
 *
 * - Below `lg` the column sits under the player, bounded (`h-112`) so the log scrolls inside it.
 *   On the watch page (`fill`, overhaul D4.1) it instead fills what the viewport leaves under the
 *   sticky player, the compact row and the Chat | About switch, so the message box sits on the
 *   viewport's bottom edge (clear of the home indicator).
 * - On `lg` it is sticky and as tall as the viewport less the site header and the page padding.
 * - In theatre mode the player spans the page and chat docks beside it at the theatre's height,
 *   the viewport less the header.
 *
 * The sizes are calc() heights, so they live in `layout.css` rather than as arbitrary Tailwind
 * values.
 */
import "./layout.css";

export function chatColumnClass(layout: { theatre: boolean; fill?: boolean }): string {
  const classes = ["h-112", "chat-column"];
  if (layout.theatre) classes.push("chat-column-theatre");
  if (layout.fill) classes.push("chat-column-fill");
  return classes.join(" ");
}

/** The column outside theatre mode, for callers that have no theatre state. */
export const CHAT_COLUMN_CLASS = chatColumnClass({ theatre: false });
