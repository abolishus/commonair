// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { LEGAL_TITLE, LegalPage, legalDocOf } from "../../components/legal-pages/legal-page.tsx";
import { getLegalDocument } from "../../components/legal-pages/loaders.ts";
import { t } from "../../i18n/index.ts";
import { titleHead } from "../../lib/page-title.ts";

/** Public (overhaul D2.7): the current community guidelines, server-rendered. `guidelines` is a reserved username. */
export const Route = createFileRoute("/_app/guidelines")({
  loader: () => getLegalDocument({ data: { kind: "guidelines" } }),
  head: ({ loaderData }) => titleHead(legalDocOf(loaderData)?.title ?? t(LEGAL_TITLE.guidelines)),
  component: GuidelinesPage,
});

function GuidelinesPage(): React.JSX.Element {
  return <LegalPage kind="guidelines" doc={legalDocOf(Route.useLoaderData())} />;
}
