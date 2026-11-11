// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { JuryEnabledSetting } from "@commonair/contracts/shapes";
import { EmptyState } from "@commonair/ui";
import { PageHeader, Section } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { JusticeScale01Icon } from "@hugeicons/core-free-icons";
import type * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";
import type { SettingLike } from "../creators/facts.ts";
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

/**
 * The `jury.enabled` governance setting: null while the settings are loading, failed to load, or
 * hold a shape we do not know, so the explainer never claims a draw it cannot confirm.
 */
export function juryEnabled(settings: readonly SettingLike[] | null): boolean | null {
  if (!settings) return null;
  const parsed = JuryEnabledSetting.safeParse(settings.find((s) => s.key === "jury.enabled")?.value);
  return parsed.success ? parsed.data.enabled : null;
}

/**
 * `/coop/jury` for signed-out visitors: what the advisory jury does and who can serve. Only a
 * confirmed `enabled` describes the monthly draw; the jury ships off (ADR 0038), and while it is
 * off the page says so, as the member page does.
 */
export function JuryExplainer({ enabled }: { enabled: boolean | null }): React.JSX.Element {
  const on = enabled === true;
  return (
    <PageContainer data-testid="jury-explainer" width="default" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("jury.page.title")} description={t("jury.page.intro")} tabs={<CoopTabs current="jury" />} />
      <div className="flex max-w-prose flex-col gap-6">
        {enabled === false && (
          <EmptyState
            data-testid="jury-explainer-disabled"
            icon={JusticeScale01Icon}
            title={t("jury.disabled.title")}
            description={t("jury.disabled.description")}
          />
        )}
        <Section heading={t("jury.explainer.title")}>
          <ul className="flex list-disc flex-col gap-2 ps-5 text-muted-foreground">
            {DUTIES.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </Section>
        <Section heading={t("d2Pages.jury.who.title")}>
          <p className="text-muted-foreground">{t(on ? "d2Pages.jury.who.body" : "d2Pages.jury.who.bodyOff")}</p>
        </Section>
        <ExplainerJoin
          path="/coop/jury"
          title={t(on ? "d2Pages.jury.join.title" : "d2Pages.jury.join.titleOff")}
          body={t(on ? "d2Pages.jury.join.body" : "d2Pages.jury.join.bodyOff")}
        />
      </div>
    </PageContainer>
  );
}
