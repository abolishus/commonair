// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageTabs, type PageTab } from "@commonair/ui/blocks/headers";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { coopNav, type CoopEntry } from "../../lib/nav.ts";

export type CoopTab = "overview" | "membership" | "proposals" | "council" | "jury" | "settings" | "patronage";

function coopTab(entry: CoopEntry): PageTab {
  switch (entry.id) {
    case "overview":
      // Exact: otherwise the router marks Overview active on every /coop/* page.
      return {
        id: entry.id,
        label: t("coop.tab.overview"),
        render: <Link to="/coop" activeOptions={{ exact: true }} />,
      };
    case "membership":
      return { id: entry.id, label: t("coop.tab.membership"), render: <Link to="/coop/membership" /> };
    case "proposals":
      return { id: entry.id, label: t("coop.tab.proposals"), render: <Link to="/coop/proposals" /> };
    case "council":
      return { id: entry.id, label: t("coop.tab.council"), render: <Link to="/coop/council" /> };
    case "jury":
      return {
        id: entry.id,
        label: t("coop.tab.jury"),
        render: <Link data-testid="coop-jury-link" to="/coop/jury" />,
      };
    case "settings":
      return { id: entry.id, label: t("coop.tab.settings"), render: <Link to="/coop/settings" /> };
    case "patronage":
      return { id: entry.id, label: t("coop.tab.patronage"), render: <Link to="/coop/patronage" /> };
    case "transparency":
      return { id: entry.id, label: t("coop.tab.transparency"), render: <Link to="/transparency" /> };
  }
}

/** The co-op section tabs (`/coop/*`, from `coopNav()`), as on the boards; links, not panels. */
export function CoopTabs({ current }: { current: CoopTab | null }): React.JSX.Element {
  return (
    <PageTabs
      variant="default"
      aria-label={t("coop.tabs")}
      items={coopNav().map((entry) => ({ ...coopTab(entry), current: entry.id === current }))}
    />
  );
}
