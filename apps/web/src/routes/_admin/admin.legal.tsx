// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { isLegal } from "../../components/safety/access.ts";
import { LegalQueue } from "../../components/safety/legal.tsx";
import { NotFoundState } from "../../components/money/not-found.tsx";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { titleHead } from "../../lib/page-title.ts";

/** `legal` only: the `_admin` layout's guard answered everyone else with not-found. */
export const Route = createFileRoute("/_admin/admin/legal")({
  head: () => titleHead(t("pageTitle.adminLegal")),
  component: LegalPage,
});

function LegalPage(): React.JSX.Element {
  const { me } = useBootstrap();
  // Client fallback: T0 material never renders for anyone but `legal`.
  if (!me || !isLegal(me)) return <NotFoundState />;
  return (
    <PageContainer width="wide" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("safety.legal.title")} description={t("safety.legal.intro")} />
      <LegalQueue meId={me.id} />
    </PageContainer>
  );
}
