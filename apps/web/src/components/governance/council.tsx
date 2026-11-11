// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatNumber, useLocale } from "@commonair/ui";
import { SeatGrid } from "@commonair/ui/blocks/coop";
import { Button } from "@commonair/ui/components/button";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { classLabel, type BoardSeatDto, type CouncilDto } from "../../lib/coop.ts";
import { percentText } from "../../lib/coop-settings-format.ts";
import { COUNCIL_GRID, contributionShare, seatingFacts } from "./model.ts";

/**
 * The seated council as avatar tiles linked to each channel (overhaul D6.3, CT-8): the top
 * `COUNCIL_GRID`, then "Show all". Each tile reads "Rank 2" and its share of contribution.
 */
export function CouncilSeats({ council }: { council: CouncilDto }): React.JSX.Element {
  const { locale } = useLocale();
  const [all, setAll] = React.useState(false);
  const listId = React.useId();
  const shown = all ? council.members : council.members.slice(0, COUNCIL_GRID);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SeatGrid
        id={listId}
        label={t("coop.council.title")}
        itemProps={{ "data-testid": "council-member" }}
        items={shown.map((m) => {
          const share = contributionShare(m.contributionScore, council);
          return {
            userId: m.user.id,
            name: m.user.displayName,
            link: { render: <Link to="/$channel" params={{ channel: m.user.username }} /> },
            eyebrow: t("coop.council.rank", { rank: m.rank }),
            meta: share === null ? undefined : t("d6Governance.council.share", { share: percentText(share, locale) }),
            attributes: { "data-rank": m.rank, "data-score": m.contributionScore },
          };
        })}
      />
      {council.members.length > COUNCIL_GRID ? (
        <div>
          <Button
            data-testid="council-show-all"
            variant="outline"
            size="sm"
            aria-expanded={all}
            aria-controls={listId}
            onClick={() => setAll((v) => !v)}
          >
            {all
              ? t("d6Governance.council.showFewer")
              : t("d6Governance.council.showAllCount", { count: council.members.length })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * "How seating works" in sentences, from the term's own method (never its JSON): the seats, who is
 * eligible, how contribution is blended and what the share on each tile means.
 */
export function SeatingExplainer({ method }: { method: CouncilDto["method"] }): React.JSX.Element {
  const { locale } = useLocale();
  const f = seatingFacts(method);
  return (
    <div data-testid="council-method" className="flex flex-col gap-2 text-sm">
      {f.size !== null && f.windowDays !== null ? (
        <p>
          {t("d6Governance.seating.seats", {
            count: f.size,
            days: formatNumber(f.windowDays, locale),
          })}
        </p>
      ) : null}
      {f.minHours !== null ? (
        <p>{t("d6Governance.seating.eligible", { hours: formatNumber(f.minHours, locale) })}</p>
      ) : null}
      {f.weights ? (
        <p>
          {t("d6Governance.seating.blend", {
            revenue: percentText(f.weights.revenue, locale),
            hours: percentText(f.weights.streamingHours, locale),
            relay: percentText(f.weights.relayBandwidth, locale),
            viewers: percentText(f.weights.viewerHours, locale),
          })}
        </p>
      ) : null}
      <p className="text-muted-foreground">{t("d6Governance.seating.share")}</p>
      {f.eligible !== null && f.candidates !== null ? (
        <p className="text-muted-foreground">
          {t("d6Governance.seating.thisTerm", {
            eligible: formatNumber(f.eligible, locale),
            candidates: formatNumber(f.candidates, locale),
          })}
        </p>
      ) : f.eligible !== null ? (
        <p className="text-muted-foreground">{t("d6Governance.seating.eligibleCount", { count: f.eligible })}</p>
      ) : null}
    </div>
  );
}

/** Board seats as people: avatar rows linked to each channel, with the class that elected them. */
export function BoardSeats({ board }: { board: readonly BoardSeatDto[] }): React.JSX.Element {
  return (
    <SeatGrid
      layout="rows"
      label={t("coop.board.title")}
      itemProps={{ "data-testid": "board-seat" }}
      items={board.map((seat) => ({
        userId: seat.user.id,
        name: seat.user.displayName,
        link: { render: <Link to="/$channel" params={{ channel: seat.user.username }} /> },
        meta: t("coop.board.seat", { class: classLabel(seat.class) }),
        attributes: { "data-class": seat.class },
      }))}
    />
  );
}
