// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The settings nav's count badges (D7.1): appeals still waiting on a decision, and copyright
 * notices still in effect on the member's content (removed, or countered and not yet restored).
 * From existing reads (`appeals.mine`, `safety.dmca.mine`); a failed read shows no badge.
 */
import type { DMCA_STATUSES } from "@commonair/contracts/enums";
import * as React from "react";
import { api } from "../../lib/api.ts";
import type { SettingsCounts } from "./settings-nav.tsx";

/** Copyright notices the member can still act on or is waiting out. */
const OPEN_DMCA: ReadonlySet<(typeof DMCA_STATUSES)[number]> = new Set(["actioned", "countered"]);

export function openAppeals(appeals: readonly { status: string }[]): number {
  return appeals.filter((a) => a.status === "open").length;
}

export function openCopyright(notices: readonly { status: (typeof DMCA_STATUSES)[number] }[]): number {
  return notices.filter((n) => OPEN_DMCA.has(n.status)).length;
}

export interface CountsClient {
  appeals(): Promise<readonly { status: string }[]>;
  copyright(): Promise<readonly { status: (typeof DMCA_STATUSES)[number] }[]>;
}

export const countsClient = (): CountsClient => ({
  appeals: () => Promise.resolve().then(() => api().appeals.mine()),
  copyright: () => Promise.resolve().then(() => api().safety.dmca.mine()),
});

/** Loads both counts once per mount of the settings layout. */
export function useSettingsCounts(client?: CountsClient): SettingsCounts {
  const [counts, setCounts] = React.useState<SettingsCounts>({});
  const [c] = React.useState(() => client ?? countsClient());
  React.useEffect(() => {
    let live = true;
    c.appeals().then(
      (list) => live && setCounts((prev) => ({ ...prev, appeals: openAppeals(list) })),
      () => {},
    );
    c.copyright().then(
      (list) => live && setCounts((prev) => ({ ...prev, copyright: openCopyright(list) })),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [c]);
  return counts;
}
