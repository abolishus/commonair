// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { AccountSettings } from "../../components/settings/account-page.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { titleHead } from "../../lib/page-title.ts";

/** Settings → Account (D7.2): name, picture, email and what channels see; the settings landing. */
export const Route = createFileRoute("/_app/settings/account")({
  head: () => titleHead(t("d7Settings.nav.account")),
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: AccountPage,
});

function AccountPage(): React.JSX.Element {
  const { me } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  return (
    <div data-testid="account-page" className="flex flex-col gap-6">
      <PageHeader title={t("d7Settings.nav.account")} description={t("d7Settings.account.intro")} />
      <AccountSettings />
    </div>
  );
}
