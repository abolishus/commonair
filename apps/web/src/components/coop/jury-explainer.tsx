// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader, Section } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import type * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";
import { ExplainerJoin } from "./explainer-join.tsx";
import { CoopTabs } from "./nav.tsx";

/** What a juror does (the jury page's own explainer, minus the draw switch's opt-out line). */
const DUTIES: readonly MessageKey[] = [
  "jury.explainer.cases",
  "jury.explainer.blur",
  "jury.explainer.names",
  "jury.explainer.votes",
  "jury.explainer.results",
];

/** `/coop/jury` for signed-out visitors: what the advisory jury does and who can serve. */
export function JuryExplainer(): React.JSX.Element {
  return (
    <PageContainer data-testid="jury-explainer" width="default" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("jury.page.title")} description={t("jury.page.intro")} tabs={<CoopTabs current="jury" />} />
      <div className="flex max-w-prose flex-col gap-6">
        <Section heading={t("jury.explainer.title")}>
          <ul className="flex list-disc flex-col gap-2 ps-5 text-muted-foreground">
            {DUTIES.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </Section>
        <Section heading={t("d2Pages.jury.who.title")}>
          <p className="text-muted-foreground">{t("d2Pages.jury.who.body")}</p>
        </Section>
        <ExplainerJoin path="/coop/jury" title={t("d2Pages.jury.join.title")} body={t("d2Pages.jury.join.body")} />
      </div>
    </PageContainer>
  );
}
