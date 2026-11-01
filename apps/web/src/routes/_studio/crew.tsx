// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { Section } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
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

/** `/crew`: revenue splits with the channel's crew (ADR 0013, W2-splits). */
export const Route = createFileRoute("/_studio/crew")({
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: CrewPage,
});

/** One page of versions is plenty: a channel changes its split a handful of times. */
const PAGE = 50;

function CrewPage(): React.JSX.Element {
  const { me, config } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  return <CrewView meId={me.id} channel={me.channelSlug ?? me.username} currency={config.currency} />;
}

function CrewView({ meId, channel, currency }: { meId: string; channel: string; currency: string }): React.JSX.Element {
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
        streamerShare={support.data?.split.streamerShare ?? 0}
        onPropose={propose}
      />
      <Section heading={t("splits.mine.title")} description={t("splits.mine.hint")}>
        {owned.failed && !owned.data ? (
          <FormError>{t("splits.loadFailed")}</FormError>
        ) : owned.data ? (
          <CrewSplitList
            splits={owned.data.items}
            meId={meId}
            canEnd
            empty={{ title: "splits.mine.empty", hint: "splits.mine.emptyHint" }}
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
