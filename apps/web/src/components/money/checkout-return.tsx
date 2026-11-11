// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * F12 (web side): the payment provider sends the payer back with `?checkout=success|canceled` and
 * `&payment=<id>`. On success the page says the payment arrived and polls it until the ledger has
 * it (`money.paymentBreakdown` answers NOT_FOUND until the payment succeeded), then confirms; on
 * cancel it says so quietly. The params are stripped with `replaceState` as soon as they are read,
 * so a reload or a shared link never replays the notice.
 *
 * Overhaul wave 2: once a sub is confirmed, a qualifying one that started the payer's viewer
 * membership (the payment webhook starts it in the same transaction) ends in "Welcome to the
 * co-op" with the payer's first vote; one the sync will still pick up says it is on its way.
 */
import { formatMoney, useLocale } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import type { MembershipViewDto } from "../../lib/coop.ts";
import { loadOpenProposals, useFirstVote, type FirstVoteLoader } from "../coop/first-vote.tsx";
import { CoopWelcome } from "../coop/welcome.tsx";
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

/**
 * What a confirmed sub did for the payer's co-op membership: `welcome` it started their viewer
 * membership just now; `joining` it qualifies and the hourly sync will start it; `none` otherwise
 * (already a member, a cheap or gifted sub, a co-op that does not count subs, or a member who left
 * the viewer class and rejoins on the membership page).
 */
export type CoopOutcome = "welcome" | "joining" | "none";

/** How far before the payment's own time a membership still counts as started by it (clock skew). */
export const WELCOME_SKEW_MS = 5 * 60_000;

/** The outcome from the payer's membership view (pure). */
export function coopOutcome(
  view: Pick<MembershipViewDto, "memberships" | "eligibility">,
  payment: Pick<PaymentBreakdownDto, "succeededAt">,
): CoopOutcome {
  const viewer = view.memberships.find((m) => m.class === "viewer");
  if (viewer?.status === "active") {
    const since = Date.parse(payment.succeededAt) - WELCOME_SKEW_MS;
    return viewer.basis === "subscription" && Date.parse(viewer.joinedAt) >= since ? "welcome" : "none";
  }
  // A voluntary exit is respected: the sync never re-enrols, so "within the hour" would be untrue.
  if (viewer?.status === "exited") return "none";
  const eligible = view.eligibility.find((e) => e.class === "viewer");
  return eligible?.eligible === true && eligible.basis === "subscription" ? "joining" : "none";
}

/** What the notice needs from the API (tests pass a stub). */
export interface CheckoutReturnClient {
  /** Rejects (NOT_FOUND) until the payment has succeeded. */
  payment: (paymentId: string) => Promise<PaymentBreakdownDto>;
  /** What the confirmed sub did for the payer's membership (`coopOutcome`). */
  coop: (payment: PaymentBreakdownDto) => Promise<CoopOutcome>;
  /** Open proposals for the welcome's first vote (`first-vote.tsx`). */
  proposals?: FirstVoteLoader;
}

const apiClient: CheckoutReturnClient = {
  payment: (paymentId) => api().money.paymentBreakdown({ paymentId }),
  coop: async (payment) => coopOutcome(await api().coop.membership(), payment),
  proposals: loadOpenProposals,
};

/** Between polls, and how long to poll before saying it is taking a while. */
export const CHECKOUT_POLL_MS = 2000;
export const CHECKOUT_SLOW_MS = 60_000;

export type CheckoutReturnState =
  | { kind: "none" }
  | { kind: "canceled" }
  | { kind: "pending" }
  | { kind: "slow" }
  | { kind: "confirmed"; payment: PaymentBreakdownDto; coop: CoopOutcome };

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
        const coop: CoopOutcome =
          payment.kind === "subscription"
            ? await clientRef.current.coop(payment).catch((): CoopOutcome => "none")
            : "none";
        if (!stopped) setState({ kind: "confirmed", payment, coop });
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
  const welcome = state.kind === "confirmed" && state.coop === "welcome";
  const firstVote = useFirstVote(
    welcome,
    state.kind === "confirmed" ? state.payment.paymentId : "-",
    client?.proposals ?? loadOpenProposals,
  );
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
        <div className="flex flex-col gap-3">
          <AlertCallout
            data-testid="checkout-return"
            data-state="confirmed"
            data-payment-id={payment.paymentId}
            data-joins-coop={state.coop === "none" ? "false" : "true"}
            data-coop={state.coop}
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
                {state.coop === "joining" && <p data-testid="checkout-return-coop">{t("fixWeb.checkout.joinsCoop")}</p>}
              </>
            }
          />
          {welcome && <CoopWelcome firstVote={firstVote} />}
        </div>
      );
    }
  }
}
