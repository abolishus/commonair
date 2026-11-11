// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Arcs, SignalBars, formatMoney, useLocale } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { isMember, type MembershipViewDto } from "../../lib/coop.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import { FALLBACK_CURRENCY, type MembershipFacts } from "../creators/facts.ts";

/**
 * Whether `/coop` shows the band: to visitors, and to accounts whose membership loaded with no
 * active class. Never while a signed-in member's membership is still loading (no flash of a pitch
 * at a member).
 */
export function showJoinBand(signedIn: boolean, membership: Pick<MembershipViewDto, "memberships"> | null): boolean {
  if (!signedIn) return true;
  return membership !== null && !isMember(membership);
}

export interface CoopJoinBandProps {
  /** `membership.classes`; null while it loads or when unreadable (the band says it in general terms). */
  membership: MembershipFacts | null;
  currency?: string;
}

/**
 * `/coop`'s join band (overhaul D2.5): the refundable share, the qualifying sub and the automatic
 * streamer class, with the page's one filled call to action. It needs no load to render, so it
 * stays when every section of the page fails.
 */
export function CoopJoinBand({ membership, currency = FALLBACK_CURRENCY }: CoopJoinBandProps): React.JSX.Element {
  const { locale } = useLocale();
  const money = (cents: number) => formatMoney(cents, currency, locale);
  React.useEffect(() => {
    trackUi("coop.band", "view");
  }, []);
  return (
    <section
      data-testid="coop-join-band"
      aria-labelledby="coop-join-band-title"
      className="relative flex flex-col gap-4 overflow-hidden bg-brand-subtle p-5 ring-1 ring-brand-text/35 ring-inset md:flex-row md:items-center md:gap-6 md:px-7 md:py-6"
    >
      <Arcs className="size-12 shrink-0 text-brand-text max-md:hidden" />
      <div className="min-w-0 flex-1">
        <h2 id="coop-join-band-title" className="text-lg font-semibold text-balance">
          {t("d2Pages.coopBand.title")}
        </h2>
        <p data-testid="coop-join-band-body" className="mt-1 text-muted-foreground">
          {membership ? (
            <>
              {membership.refundableOnExit
                ? t("d2Pages.coopBand.share", { shareAmount: money(membership.shareCents) })
                : t("d2Pages.coopBand.shareKept", { shareAmount: money(membership.shareCents) })}
              {membership.minSubCents !== null && (
                <> {t("d2Pages.coopBand.sub", { minSub: money(membership.minSubCents) })}</>
              )}{" "}
              {t("d2Pages.coopBand.streamers", { hours: membership.streamerHours })}
            </>
          ) : (
            t("d2Pages.coopBand.generic")
          )}
        </p>
      </div>
      <Button
        variant="brand"
        size="lg"
        data-filled-cta=""
        data-testid="coop-join-band-cta"
        nativeButton={false}
        className="min-h-11 shrink-0 px-4 max-md:w-full"
        render={<Link to="/coop/membership" onClick={() => trackUi("coop.band", "click", "join")} />}
      >
        {t("d2Pages.coopBand.cta")}
      </Button>
      <SignalBars variant="band" className="absolute inset-x-0 bottom-0 h-0.75 w-full" />
    </section>
  );
}
