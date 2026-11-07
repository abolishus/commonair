// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * F12 (web side): the payment provider sends the payer back with `?checkout=success|canceled` and
 * `&payment=<id>`. On success the page says the payment arrived and polls it until the ledger has
 * it (`money.paymentBreakdown` answers NOT_FOUND until the payment succeeded), then confirms; on
 * cancel it says so quietly. The params are stripped with `replaceState` as soon as they are read,
 * so a reload or a shared link never replays the notice.
 */
import { formatMoney, useLocale } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import type { PaymentBreakdownDto } from "./breakdown-table.tsx";

export const CHECKOUT_PARAM = "checkout";
export const PAYMENT_PARAM = "payment";

const PAYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CheckoutReturnParams = { outcome: "canceled" } | { outcome: "success"; paymentId: string };

/** The return params in a query string, or null when there are none (or they are malformed). */
export function readCheckoutReturn(search: string): CheckoutReturnParams | null {
  const params = new URLSearchParams(search);
  const outcome = params.get(CHECKOUT_PARAM);
  if (outcome === "canceled") return { outcome };
  const paymentId = params.get(PAYMENT_PARAM);
  if (outcome === "success" && paymentId && PAYMENT_ID.test(paymentId))
    return { outcome, paymentId: paymentId.toLowerCase() };
  return null;
}

/** `href`'s path, query and hash without the return params (the rest of the query kept, in order). */
export function withoutCheckoutParams(href: string): string {
  const url = new URL(href, "https://commonair.invalid");
  url.searchParams.delete(CHECKOUT_PARAM);
  url.searchParams.delete(PAYMENT_PARAM);
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
}

/** What the notice needs from the API (tests pass a stub). */
export interface CheckoutReturnClient {
  /** Rejects (NOT_FOUND) until the payment has succeeded. */
  payment: (paymentId: string) => Promise<PaymentBreakdownDto>;
  /**
   * The subscription will make the payer a viewer member: they are not one yet and their
   * subscription qualifies (paid, not a gift, at least the minimum, the co-op counts subs).
   */
  joinsCoop: () => Promise<boolean>;
}

const apiClient: CheckoutReturnClient = {
  payment: (paymentId) => api().money.paymentBreakdown({ paymentId }),
  joinsCoop: async () => {
    const view = await api().coop.membership();
    if (view.memberships.some((m) => m.class === "viewer" && m.status === "active")) return false;
    const viewer = view.eligibility.find((e) => e.class === "viewer");
    return viewer?.eligible === true && viewer.basis === "subscription";
  },
};

/** Between polls, and how long to poll before saying it is taking a while. */
export const CHECKOUT_POLL_MS = 2000;
export const CHECKOUT_SLOW_MS = 60_000;

export type CheckoutReturnState =
  | { kind: "none" }
  | { kind: "canceled" }
  | { kind: "pending" }
  | { kind: "slow" }
  | { kind: "confirmed"; payment: PaymentBreakdownDto; joinsCoop: boolean };

/**
 * Reads the return params once on mount (the browser's own URL: the router's search schema drops
 * unknown keys), strips them, and polls the payment on success.
 */
export function useCheckoutReturn({
  client = apiClient,
  pollMs = CHECKOUT_POLL_MS,
  slowMs = CHECKOUT_SLOW_MS,
}: { client?: CheckoutReturnClient; pollMs?: number; slowMs?: number } = {}): CheckoutReturnState {
  const [state, setState] = React.useState<CheckoutReturnState>({ kind: "none" });
  const clientRef = React.useRef(client);
  // Read once: the params are gone after the strip, and an effect may run twice (StrictMode).
  const paramsRef = React.useRef<CheckoutReturnParams | null | undefined>(undefined);
  React.useEffect(() => {
    if (paramsRef.current === undefined) {
      paramsRef.current = readCheckoutReturn(window.location.search);
      // Keep the router's history state (its keys) so Back still works as before.
      if (paramsRef.current)
        window.history.replaceState(window.history.state, "", withoutCheckoutParams(window.location.href));
    }
    const params = paramsRef.current;
    if (!params) return;
    if (params.outcome === "canceled") {
      setState({ kind: "canceled" });
      return;
    }
    setState({ kind: "pending" });
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const poll = async (): Promise<void> => {
      try {
        const payment = await clientRef.current.payment(params.paymentId);
        if (stopped) return;
        const joins = payment.kind === "subscription" ? await clientRef.current.joinsCoop().catch(() => false) : false;
        if (!stopped) setState({ kind: "confirmed", payment, joinsCoop: joins });
        return;
      } catch {
        // Not confirmed yet (or a blip): ask again until it is slow.
      }
      if (stopped) return;
      if (Date.now() - started >= slowMs) {
        setState({ kind: "slow" });
        return;
      }
      timer = setTimeout(() => void poll(), pollMs);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pollMs, slowMs]);
  return state;
}

/** The creators' part of a payment: its `creator` lines (one per recipient). */
export function creatorCents(payment: Pick<PaymentBreakdownDto, "lines">): number {
  return payment.lines.filter((l) => l.kind === "creator").reduce((sum, l) => sum + l.amount.cents, 0);
}

/** The notice on the channel page after checkout; nothing without return params. */
export function CheckoutReturn({
  channelName,
  client,
  pollMs,
  slowMs,
}: {
  channelName: string;
  client?: CheckoutReturnClient;
  pollMs?: number;
  slowMs?: number;
}): React.JSX.Element | null {
  const { locale } = useLocale();
  const state = useCheckoutReturn({ client, pollMs, slowMs });
  switch (state.kind) {
    case "none":
      return null;
    case "canceled":
      return (
        <output data-testid="checkout-return" data-state="canceled" className="block text-sm text-muted-foreground">
          {t("fixWeb.checkout.canceled")}
        </output>
      );
    case "pending":
    case "slow":
      return (
        <AlertCallout
          data-testid="checkout-return"
          data-state={state.kind}
          tone="info"
          live
          aria-busy={state.kind === "pending" || undefined}
          title={t("fixWeb.checkout.pending", { channel: channelName })}
          description={state.kind === "slow" ? t("fixWeb.checkout.slow") : undefined}
        />
      );
    case "confirmed": {
      const { payment } = state;
      const subscription = payment.kind === "subscription";
      return (
        <AlertCallout
          data-testid="checkout-return"
          data-state="confirmed"
          data-payment-id={payment.paymentId}
          data-joins-coop={state.joinsCoop ? "true" : "false"}
          tone="info"
          live
          title={
            subscription
              ? t("fixWeb.checkout.subscribed", { channel: payment.channel.displayName })
              : t("fixWeb.checkout.tipped", { channel: payment.channel.displayName })
          }
          description={
            <>
              <p>
                {t("fixWeb.checkout.share", {
                  channel: payment.channel.displayName,
                  amount: formatMoney(creatorCents(payment), payment.gross.currency, locale),
                  price: formatMoney(payment.gross.cents, payment.gross.currency, locale),
                })}
              </p>
              {state.joinsCoop && <p data-testid="checkout-return-coop">{t("fixWeb.checkout.joinsCoop")}</p>}
            </>
          }
        />
      );
    }
  }
}
