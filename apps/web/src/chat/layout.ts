// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The chat column's size classes (D2-chat owns them; the channel page applies them to `ChatPanel`
 * and its pending skeleton). Contract-step seam: today's fixed heights until D2-chat lands.
 */
export function chatColumnClass(_layout: { theatre: boolean }): string {
  return "h-112 lg:h-160";
}
