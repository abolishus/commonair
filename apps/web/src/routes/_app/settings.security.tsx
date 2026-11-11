// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { SecurityPage } from "../../components/security/security-page.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * Settings: Security (D7.2). The two-step sign-in mails link here, and the new-sign-in mail links
 * `#sessions` (`SECURITY_SETTINGS_PATH`, `SESSIONS_SETTINGS_PATH`).
 */
export const Route = createFileRoute("/_app/settings/security")({
  beforeLoad: () => requireSession(() => getSessionUser()),
  head: () => titleHead(t("d7Settings.nav.security")),
  component: SecurityRoute,
});

function SecurityRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  // Client fallback for a session that ended after the guard ran.
  if (!me) return <Navigate to="/signin" replace />;
  return (
    <div data-testid="security-page" className="flex min-w-0 flex-col gap-6">
      <PageHeader title={t("d7Settings.nav.security")} description={t("d7Security.intro")} />
      <SecurityPage />
    </div>
  );
}
