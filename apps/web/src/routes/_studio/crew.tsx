// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { Section } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { FocusFormAction } from "../../components/studio/empty-action.tsx";
import { FormError } from "../../components/form-error.tsx";
import {
  CrewListSkeleton,
  CrewOffered,
  CrewPayoutNote,
  CrewProposeForm,
  CrewSplitList,
  type ProposeInput,
} from "../../components/money/crew.tsx";
import { useLoad } from "../../components/money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { titleHead } from "../../lib/page-title.ts";

/** `/crew`: revenue splits with the channel's crew (ADR 0013, W2-splits). */
export const Route = createFileRoute("/_studio/crew")({
  head: () => titleHead(t("pageTitle.studioCrew")),
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: CrewPage,
});

/** One page of versions is plenty: a channel changes its split a handful of times. */
const PAGE = 50;

function CrewPage(): React.JSX.Element {
  const { me, config, now } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  return <CrewView meId={me.id} channel={me.channelSlug ?? me.username} currency={config.currency} now={now} />;
}

function CrewView({
  meId,
  channel,
  currency,
  now,
}: {
  meId: string;
  channel: string;
  currency: string;
  now: number;
}): React.JSX.Element {
  const owned = useLoad(`owned|${channel}`, () => api().money.splits.list({ channel, limit: PAGE }));
  const offered = useLoad(`offered|${meId}`, () => api().money.splits.list({ limit: PAGE }));
  const support = useLoad(`support|${channel}`, () => api().money.support({ channel }));
  const reload = () => {
    owned.reload();
    offered.reload();
  };

  const propose = async (input: ProposeInput) => {
    await api().money.splits.propose({ channel, ...input });
    owned.reload();
  };
  const answer = async (id: string, accept: boolean) => {
    if (accept) await api().money.splits.accept({ id });
    else await api().money.splits.reject({ id });
    reload();
  };
  const end = async (id: string) => {
    await api().money.splits.end({ channel, id });
    owned.reload();
  };

  return (
    <PageContainer data-testid="crew-page" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("splits.title")} description={t("splits.intro")} />
      <CrewPayoutNote />
      <CrewProposeForm
        currency={support.data?.currency ?? currency}
        streamerShare={support.data?.split.streamerShare ?? null}
        onPropose={propose}
        now={now}
      />
      <Section heading={t("splits.mine.title")} description={t("splits.mine.hint")}>
        {owned.failed && !owned.data ? (
          <FormError>{t("splits.loadFailed")}</FormError>
        ) : owned.data ? (
          <CrewSplitList
            splits={owned.data.items}
            meId={meId}
            canEnd
            empty={{
              title: "splits.mine.empty",
              hint: "splits.mine.emptyHint",
              action: (
                <FocusFormAction selector='[data-testid="crew-recipient"]'>
                  {t("studio.empty.proposeSplit")}
                </FocusFormAction>
              ),
            }}
            onAnswer={answer}
            onEnd={end}
          />
        ) : (
          <CrewListSkeleton />
        )}
      </Section>
      {offered.failed && !offered.data ? (
        <FormError>{t("splits.loadFailed")}</FormError>
      ) : offered.data ? (
        <CrewOffered splits={offered.data.items} meId={meId} onAnswer={answer} />
      ) : (
        <CrewListSkeleton />
      )}
    </PageContainer>
  );
}
