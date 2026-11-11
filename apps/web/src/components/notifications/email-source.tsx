// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Links in our own email carry `?src=` (`EMAIL_LINK_SOURCES`, overhaul wave 4, D7.3): the page
 * counts the visit in aggregate (`trackUi("digest", "click")`, no id, no address) and strips the
 * parameter with `replaceState`, so a copied or bookmarked link never counts again.
 */
import * as React from "react";
import { emailSourceOf } from "../../lib/notifications.ts";
import { trackUi } from "../../lib/ui-metrics.ts";

/** Count and strip `?src=` once per page load. Exported for tests (`win` is the browser's window). */
export function consumeEmailSource(win: Pick<Window, "location" | "history"> = window): boolean {
  const found = emailSourceOf(win.location.href);
  if (!found) return false;
  trackUi("digest", "click");
  win.history.replaceState(win.history.state, "", found.stripped);
  return true;
}

export function useEmailSource(): void {
  React.useEffect(() => {
    consumeEmailSource();
  }, []);
}
