// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import type * as React from "react";
import { z } from "zod";
import { t } from "../../i18n/index.ts";
import { canBuyShare, type MembershipViewDto, type SettingDto } from "../../lib/coop.ts";

/**
 * "Pay by card" for the member share (batch 8, M1-coop-money; docs/testing/b8-selectors.md
 * `share-buy-stripe`). Shown only when the instance runs Stripe and the co-op voted
 * `shares.cardPayments` on; otherwise the page keeps the bank-transfer instructions. The button
 * goes to Stripe Checkout (`coop.buyShare` answers a redirect); a card checkout still open shows
 * "Continue to checkout", which returns the same session.
 */

const CardPayments = z.object({ enabled: z.boolean() });

/** Whether card payment for shares is open here: Stripe on the instance and the setting on (pure). */
export function cardSharesAllowed(
  payments: "manual" | "stripe" | null,
  settings: readonly Pick<SettingDto, "key" | "value">[] | null,
): boolean {
  if (payments !== "stripe") return false;
  const parsed = CardPayments.safeParse(settings?.find((s) => s.key === "shares.cardPayments")?.value);
  return parsed.success && parsed.data.enabled;
}

/** A pending share without bank-transfer details is a card checkout still open (pure). */
export function openCardCheckout(view: Pick<MembershipViewDto, "share"> | null): boolean {
  const s = view?.share;
  return s?.status === "pending" && s.reference === null;
}

export interface SharePayByCardProps {
  view: MembershipViewDto | null;
  /** Starts (or continues) the checkout; the page navigates to Stripe. */
  onPay: () => void | Promise<void>;
  paying: boolean;
}

export function SharePayByCard({ view, onPay, paying }: SharePayByCardProps): React.JSX.Element | null {
  if (!view) return null;
  const open = openCardCheckout(view);
  if (!open && !canBuyShare(view)) return null;
  return (
    <PageContainer width="wide" className="pb-8">
      <Section
        heading={t("coopMoney.card.title")}
        description={open ? t("coopMoney.card.pending") : t("coopMoney.card.description")}
      >
        <div className="flex flex-col items-start gap-3">
          <Button
            data-testid="share-buy-stripe"
            disabled={paying}
            aria-busy={paying || undefined}
            onClick={() => void onPay()}
          >
            {paying
              ? t("coopMoney.card.redirecting")
              : open
                ? t("coopMoney.card.continue")
                : t("coopMoney.card.button")}
          </Button>
          <p className="text-sm text-muted-foreground">{t("coopMoney.card.refunds")}</p>
        </div>
      </Section>
    </PageContainer>
  );
}
