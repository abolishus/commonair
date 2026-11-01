// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { RelativeTime, StatusBadge } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { GiftIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { type MessageKey, t } from "../../i18n/index.ts";
import { fillNode } from "../../lib/fill.tsx";
import { INELIGIBLE_KEYS, STATUS_KEYS, enterErrorKey } from "../../components/giveaways/logic.ts";
import { GiveawayRulesLink, type RulesClient } from "../../components/giveaways/rules-link.tsx";
import type { InteractClient } from "./client.ts";
import type { GiveawayDto } from "./state.ts";

export interface GiveawayCardProps {
  channel: string;
  giveaway: GiveawayDto;
  signedIn: boolean;
  /** `giveawayEnter`; tests pass a fake. */
  client: InteractClient;
  /** The giveaway as `interact.giveaways.enter` returned it. */
  onEntered: (giveaway: GiveawayDto) => void;
  /** Where the official rules load from (tests pass a fake). */
  rulesClient?: RulesClient;
}

/** What the card's action row shows, from the giveaway and the viewer. */
export type GiveawayCardState =
  | "enter"
  | "signIn"
  | "entered"
  | "ineligible"
  | "won"
  | "closed"
  | "cancelled"
  | "drawn";

export function giveawayCardState(g: GiveawayDto, signedIn: boolean): GiveawayCardState {
  if (g.status === "cancelled") return "cancelled";
  if (g.me?.won) return "won";
  if (g.me?.entered) return g.status === "drawn" ? "drawn" : "entered";
  if (g.status === "drawn") return "drawn";
  if (g.status !== "open") return "closed";
  if (!signedIn || g.me === null) return "signIn";
  return g.me.eligible ? "enter" : "ineligible";
}

/**
 * The viewer's giveaway card in the chat panel (ADR 0039): what is given away, the enter button
 * (or why the viewer cannot enter), "no purchase necessary", the official rules and the public
 * verify page. Only mounted while the instance has giveaways on. Entry is free, by this button or
 * by typing the keyword in chat.
 */
export function GiveawayCard({
  channel,
  giveaway: g,
  signedIn,
  client,
  onEntered,
  rulesClient,
}: GiveawayCardProps): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<MessageKey | null>(null);
  const state = giveawayCardState(g, signedIn);

  const enter = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      onEntered(await client.giveawayEnter({ id: g.id }));
    } catch (err) {
      setError(enterErrorKey(err));
    } finally {
      setPending(false);
    }
  };

  const reason = g.me?.reason ?? null;
  const headingId = React.useId();
  return (
    <Card
      size="sm"
      data-testid="chat-giveaway"
      data-giveaway-id={g.id}
      data-status={g.status}
      data-entries={g.entries}
      aria-labelledby={headingId}
    >
      <CardHeader>
        <CardTitle id={headingId} className="flex min-w-0 items-center gap-2">
          <HugeiconsIcon icon={GiftIcon} strokeWidth={2} aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{g.title}</span>
          <StatusBadge tone={g.status === "open" ? "success" : "neutral"}>{t(STATUS_KEYS[g.status])}</StatusBadge>
        </CardTitle>
        <CardDescription className="break-words">{t("giveaways.card.prize", { prize: g.prize })}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-2">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {t("giveaways.card.entries", { count: g.entries })}
          {g.status === "open" && g.closesAt
            ? fillNode(t("giveaways.card.closesIn"), "time", <RelativeTime date={g.closesAt} tooltip={false} />)
            : null}
        </p>
        {g.keyword && g.status === "open" ? (
          <p className="text-xs">{t("giveaways.card.keyword", { keyword: g.keyword })}</p>
        ) : null}
        <div aria-live="polite" className="flex min-w-0 flex-col gap-2">
          {state === "enter" ? (
            <Button
              type="button"
              size="sm"
              data-testid="chat-giveaway-enter"
              disabled={pending}
              onClick={() => void enter()}
            >
              {t("giveaways.card.enter")}
            </Button>
          ) : null}
          {state === "signIn" ? <p className="text-xs">{t("giveaways.card.signIn")}</p> : null}
          {state === "entered" ? (
            <p data-testid="chat-giveaway-entered" className="text-xs font-medium">
              {t("giveaways.card.entered")}
            </p>
          ) : null}
          {state === "ineligible" && reason ? (
            <p data-testid="chat-giveaway-ineligible" data-reason={reason} className="text-xs">
              {t(INELIGIBLE_KEYS[reason])}
            </p>
          ) : null}
          {state === "won" ? (
            <p data-testid="chat-giveaway-won" className="text-xs font-medium">
              {t("giveaways.card.won")}
            </p>
          ) : null}
          {state === "closed" ? <p className="text-xs">{t("giveaways.card.closed")}</p> : null}
          {state === "cancelled" ? <p className="text-xs">{t("giveaways.card.cancelled")}</p> : null}
          {state === "drawn" ? (
            <p className="text-xs">{t("giveaways.card.drawn", { count: g.winners.length })}</p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {t(error)}
            </p>
          ) : null}
        </div>
        <p data-testid="chat-giveaway-no-purchase" className="text-xs text-muted-foreground">
          {t("giveaways.card.noPurchase")}
        </p>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <GiveawayRulesLink client={rulesClient} />
          <Link
            data-testid="chat-giveaway-verify-link"
            to="/$channel/giveaways/$giveawayId"
            params={{ channel, giveawayId: g.id }}
            className="underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("giveaways.card.verify")}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
