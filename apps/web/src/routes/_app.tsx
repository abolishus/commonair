// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AppShell } from "@commonair/ui/layouts";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { LegalPending } from "../components/legal-pending.tsx";
import { AppFooter, AppHeader } from "../components/site-chrome.tsx";
import { t } from "../i18n/index.ts";

/** Site chrome (header + footer) for every public page; creator tools use `_studio`, embeds none. */
export const Route = createFileRoute("/_app")({ component: AppLayout });

function AppLayout(): React.JSX.Element {
  return (
    <AppShell header={<AppHeader />} footer={<AppFooter />} skipLabel={t("nav.skipToContent")}>
      <LegalPending />
      <Outlet />
    </AppShell>
  );
}
