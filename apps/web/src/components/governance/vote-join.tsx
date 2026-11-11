// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatMoney, useLocale } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { AuthGateActions } from "../auth-gate/auth-gate-prompt.tsx";
import { FALLBACK_CURRENCY, type MembershipFacts } from "../creators/facts.ts";

/**
 * The vote card for someone who cannot vote yet (coop-trust CT-7): "Members vote", how to join
 * (the refundable share, or a qualifying subscription), and the way in. Signed out, the join gate's
 * actions (create an account first, then join); signed in, the membership page.
 */
export function VoteJoinPrompt({
  signedIn,
  facts,
  currency = FALLBACK_CURRENCY,
}: {
  signedIn: boolean;
  /** `membership.classes` (null: the card says it in general terms). */
  facts: MembershipFacts | null;
  currency?: string;
}): React.JSX.Element {
  const { locale } = useLocale();
  const money = (cents: number) => formatMoney(cents, currency, locale);
  return (
    <Card size="sm" data-testid="vote-join">
      <CardHeader>
        <CardTitle>{t("d6Governance.vote.joinTitle")}</CardTitle>
        <CardDescription>
          {facts ? (
            <>
              {facts.refundableOnExit
                ? t("d6Governance.vote.joinShare", { share: money(facts.shareCents) })
                : t("d6Governance.vote.joinShareKept", { share: money(facts.shareCents) })}
              {facts.minSubCents !== null ? (
                <> {t("d6Governance.vote.joinSub", { minSub: money(facts.minSubCents) })}</>
              ) : null}
            </>
          ) : (
            t("d6Governance.vote.joinGeneric")
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {signedIn ? (
          <Button
            variant="brand"
            data-filled-cta=""
            data-testid="vote-join-membership"
            nativeButton={false}
            render={<Link to="/coop/membership" />}
          >
            {t("d6Governance.vote.joinCta")}
          </Button>
        ) : (
          <AuthGateActions intent="join" testIds={{ create: "vote-join-create", signIn: "vote-join-signin" }} />
        )}
      </CardContent>
    </Card>
  );
}
