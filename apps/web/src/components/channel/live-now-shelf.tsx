// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The unknown-channel page (F13): D4's `ChannelNotFoundState` (a sentence and "Browse live
 * channels"), then a Live now shelf so the visitor has somewhere to go. The shelf asks
 * `directory.live` in the browser and shows nothing when nobody is live or the call fails.
 */
import type { StreamCard } from "@commonair/contracts/dto";
import { PageContainer } from "@commonair/ui/layouts";
import { Section } from "@commonair/ui/blocks/headers";
import { StreamGrid } from "@commonair/ui/blocks/media";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { ChannelNotFoundState } from "../not-found.tsx";

export const LIVE_NOW_COUNT = 6;

export type LiveNowLoader = () => Promise<StreamCard[]>;

const liveNow: LiveNowLoader = async () => (await api().directory.live({ limit: LIVE_NOW_COUNT })).items;

export function LiveNowShelf({ load = liveNow }: { load?: LiveNowLoader }): React.JSX.Element | null {
  const [cards, setCards] = React.useState<StreamCard[] | null>(null);
  const [done, setDone] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    load().then(
      (items) => {
        if (cancelled) return;
        setCards(items.slice(0, LIVE_NOW_COUNT));
        setDone(true);
      },
      () => {
        if (!cancelled) setDone(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [load]);
  if (done && (cards === null || cards.length === 0)) return null;
  return (
    <Section data-testid="channel-live-now" heading={t("channel.meta.liveNow")}>
      <StreamGrid
        streams={cards ?? []}
        loading={!done}
        loadingCount={3}
        hrefFor={(card) => `/${card.channel.slug}`}
        renderLink={(card) => <Link to="/$channel" params={{ channel: card.channel.slug }} />}
        cardProps={(card) => ({ "data-testid": "stream-card", "data-channel": card.channel.slug })}
      />
    </Section>
  );
}

export function ChannelNotFoundPage({ load }: { load?: LiveNowLoader }): React.JSX.Element {
  return (
    <>
      <ChannelNotFoundState />
      <PageContainer width="wide" className="pb-12">
        <LiveNowShelf load={load} />
      </PageContainer>
    </>
  );
}
