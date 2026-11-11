// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SettingsSection } from "@commonair/ui/blocks/forms";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { MyCopyright } from "../../components/dmca/copyright.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { titleHead } from "../../lib/page-title.ts";

/** Signed in: copyright notices about your content and the counter-notice (E7-dmca). */
export const Route = createFileRoute("/_app/settings/copyright")({
  head: () => titleHead(t("d7Settings.nav.copyright")),
  beforeLoad: () => requireSession(() => getSessionUser()),
  // `?notice=<id>` (the link in the `dmcaNoticeReceived` mail) scrolls to that notice.
  validateSearch: (search: Record<string, unknown>): { notice?: string } =>
    typeof search.notice === "string" && /^[0-9a-f-]{36}$/i.test(search.notice) ? { notice: search.notice } : {},
  component: CopyrightPage,
});

function CopyrightPage(): React.JSX.Element {
  const { me } = useBootstrap();
  const { notice } = Route.useSearch();
  if (!me) return <Navigate to="/signin" replace />;
  return (
    <div data-testid="copyright-page" className="flex flex-col gap-6">
      {/* D7.1: the h1 is the nav label; the notices are one settings section. */}
      <PageHeader title={t("d7Settings.nav.copyright")} description={t("copyright.intro")} />
      <SettingsSection
        data-testid="copyright-section"
        title={t("d7Settings.copyright.title")}
        description={t("d7Settings.copyright.intro")}
      >
        <div className="px-4 py-4 sm:px-6">
          <MyCopyright focusNoticeId={notice} />
        </div>
      </SettingsSection>
    </div>
  );
}
