// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { MyAppeals } from "../../components/safety/appeals.tsx";
import { EnforcementSection } from "../../components/safety/enforcement.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { titleHead } from "../../lib/page-title.ts";

export const Route = createFileRoute("/_app/settings/appeals")({
  head: () => titleHead(t("d7Settings.nav.appeals")),
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: AppealsPage,
});

function AppealsPage(): React.JSX.Element {
  const { me } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  return (
    <div data-testid="appeals" className="flex flex-col gap-6">
      {/* D7.1: the h1 is the nav label. */}
      <PageHeader title={t("d7Settings.nav.appeals")} description={t("safety.appeals.intro")} />
      {/* Statements of reasons (ADR 0019) above the appeals they lead to. */}
      <EnforcementSection />
      <MyAppeals />
    </div>
  );
}
