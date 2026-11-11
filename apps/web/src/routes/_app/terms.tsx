// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { LEGAL_TITLE, LegalPage, legalDocOf } from "../../components/legal-pages/legal-page.tsx";
import { getLegalDocument } from "../../components/legal-pages/loaders.ts";
import { t } from "../../i18n/index.ts";
import { titleHead } from "../../lib/page-title.ts";

/** Public (overhaul D2.7): the current terms of service, server-rendered. `terms` is a reserved username. */
export const Route = createFileRoute("/_app/terms")({
  loader: () => getLegalDocument({ data: { kind: "terms" } }),
  head: ({ loaderData }) => titleHead(legalDocOf(loaderData)?.title ?? t(LEGAL_TITLE.terms)),
  component: TermsPage,
});

function TermsPage(): React.JSX.Element {
  return <LegalPage kind="terms" doc={legalDocOf(Route.useLoaderData())} />;
}
