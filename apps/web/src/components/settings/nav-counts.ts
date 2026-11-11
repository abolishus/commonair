// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The settings nav's count badges (D7.1): appeals still waiting on a decision, and copyright
 * notices still in effect on the member's content (removed, or countered and not yet restored).
 * The counts come with `Me.settingsSummary` (the same rules as `openAppeals`/`openCopyright` over
 * `appeals.mine` and `safety.dmca.mine`), so a settings page load makes no extra requests: the
 * e4b-money scenario fills a member's rate-limit bucket with settings page loads otherwise.
 */
import type { DMCA_STATUSES } from "@commonair/contracts/enums";
import type { SettingsCounts } from "./settings-nav.tsx";

/** Copyright notices the member can still act on or is waiting out. */
const OPEN_DMCA: ReadonlySet<(typeof DMCA_STATUSES)[number]> = new Set(["actioned", "countered"]);

export function openAppeals(appeals: readonly { status: string }[]): number {
  return appeals.filter((a) => a.status === "open").length;
}

export function openCopyright(notices: readonly { status: (typeof DMCA_STATUSES)[number] }[]): number {
  return notices.filter((n) => OPEN_DMCA.has(n.status)).length;
}

/** What `Me.settingsSummary` carries for the badges (no request of its own: the bootstrap has it). */
export interface SummaryCounts {
  openAppeals: number;
  openCopyright: number;
}

/** The badges from the bootstrap's `Me.settingsSummary`; none when it is missing. */
export function settingsCounts(summary: SummaryCounts | null | undefined): SettingsCounts {
  return summary ? { appeals: summary.openAppeals, copyright: summary.openCopyright } : {};
}
