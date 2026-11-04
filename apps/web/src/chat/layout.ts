// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The chat column's size classes (D2-chat owns them; the channel page applies them to `ChatPanel`
 * and its pending skeleton). Design review F6: chat fills the column beside the player.
 *
 * - Below `lg` the column sits under the player, bounded (`h-112`) so the log scrolls inside it.
 * - On `lg` it is sticky and as tall as the viewport less the site header and the page padding.
 * - In theatre mode the player spans the page and chat docks beside it at the theatre's height,
 *   the viewport less the header.
 *
 * The `lg` sizes are calc() heights, so they live in `layout.css` rather than as arbitrary
 * Tailwind values.
 */
import "./layout.css";

export function chatColumnClass(layout: { theatre: boolean }): string {
  return layout.theatre ? "h-112 chat-column chat-column-theatre" : "h-112 chat-column";
}

/** The column outside theatre mode, for callers that have no theatre state. */
export const CHAT_COLUMN_CLASS = chatColumnClass({ theatre: false });
