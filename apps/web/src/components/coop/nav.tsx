// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageTabs, type PageTab } from "@commonair/ui/blocks/headers";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";

export type CoopTab = "overview" | "membership" | "proposals" | "council" | "settings" | "patronage";

/** The co-op section tabs (`/coop/*`), as on the boards; links, not panels. */
export function CoopTabs({ current }: { current: CoopTab | null }): React.JSX.Element {
  const items: PageTab[] = [
    { id: "overview", label: t("coop.tab.overview"), render: <Link to="/coop" /> },
    { id: "membership", label: t("coop.tab.membership"), render: <Link to="/coop/membership" /> },
    { id: "proposals", label: t("coop.tab.proposals"), render: <Link to="/coop/proposals" /> },
    { id: "council", label: t("coop.tab.council"), render: <Link to="/coop/council" /> },
    { id: "settings", label: t("coop.tab.settings"), render: <Link to="/coop/settings" /> },
    { id: "patronage", label: t("coop.tab.patronage"), render: <Link to="/coop/patronage" /> },
    { id: "transparency", label: t("coop.tab.transparency"), render: <Link to="/transparency" /> },
  ];
  return (
    <PageTabs
      variant="default"
      aria-label={t("coop.tabs")}
      items={items.map((item) => ({ ...item, current: item.id === current }))}
    />
  );
}
