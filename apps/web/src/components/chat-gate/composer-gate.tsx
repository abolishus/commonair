// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatRelativeTime, useLocale } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Dialog, DialogTrigger } from "@commonair/ui/components/dialog";
import { FavouriteIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import type { GateReason } from "../../chat/gate-reason.ts";
import { durationLabel } from "../../chat/modes.ts";
import { t } from "../../i18n/index.ts";
import { ResendVerification } from "../resend-verification.tsx";
import { SupportDialogContent, apiSupportClient, type SupportClient } from "../support/support-dialog.tsx";

/**
 * Why the viewer cannot chat yet and what to do about it, in the composer row before they type
 * (`chat-composer-gate`, ux-journeys J3-d). One reason at a time, the first the server would give.
 * Subscribers-only offers the Support dialog right there (`chat-composer-gate-support`).
 */
export function ComposerGate({
  reason,
  channel,
  channelName,
  email,
  now,
  supportClient = apiSupportClient,
}: {
  reason: GateReason;
  /** The channel's slug, for the Support dialog. */
  channel: string;
  channelName: string;
  /** The viewer's address, for "Resend verification email"; omitted when unknown. */
  email?: string | undefined;
  /** The page's clock (ms), for when an account is old enough. */
  now: number;
  /** The Support dialog's calls; tests pass a fake. */
  supportClient?: SupportClient | undefined;
}): React.JSX.Element {
  const { locale } = useLocale();
  return (
    <section
      aria-live="polite"
      data-testid="chat-composer-gate"
      data-reason={reason.kind}
      className="flex min-w-0 flex-col gap-1 px-1 text-xs"
    >
      <p className="break-words font-medium">{title(reason, channelName)}</p>
      <p className="break-words text-muted-foreground">{next(reason, channelName, locale, now)}</p>
      {reason.kind === "verifiedEmail" && email ? <ResendVerification email={email} /> : null}
      {reason.kind === "subs" ? (
        <SubscribeToChat channel={channel} channelName={channelName} client={supportClient} />
      ) : null}
    </section>
  );
}

/** "Sub to chat": the channel's Support dialog, opened from the gate (never a second brand CTA). */
function SubscribeToChat({
  channel,
  channelName,
  client,
}: {
  channel: string;
  channelName: string;
  client: SupportClient;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="chat-composer-gate-support"
            className="self-start"
            aria-label={t("w5Watch.gate.subscribeLabel", { channel: channelName })}
          />
        }
      >
        <HugeiconsIcon icon={FavouriteIcon} strokeWidth={2} aria-hidden />
        {t("w5Watch.gate.subscribe")}
      </DialogTrigger>
      {open && (
        <SupportDialogContent
          channel={channel}
          channelName={channelName}
          client={client}
          onClose={() => setOpen(false)}
        />
      )}
    </Dialog>
  );
}

function title(reason: GateReason, channel: string): string {
  switch (reason.kind) {
    case "verifiedEmail":
      return t("d4Chat.gate.verifiedEmail");
    case "accountAge":
      return t("d4Chat.gate.accountAge", { channel, count: reason.days });
    case "followers":
      return reason.minutes === 0
        ? t("d4Chat.gate.followers", { channel })
        : t("d4Chat.gate.followersAge", { channel, duration: durationLabel(reason.minutes * 60) });
    case "subs":
      return t("d4Chat.gate.subs", { channel });
  }
}

function next(reason: GateReason, channel: string, locale: string, now: number): string {
  switch (reason.kind) {
    case "verifiedEmail":
      return t("d4Chat.gate.verifiedEmailNext");
    case "accountAge":
      // "in 3 days": the formatter's own words, never a countdown.
      return reason.opensAt
        ? t("d4Chat.gate.accountAgeOpens", { when: formatRelativeTime(new Date(reason.opensAt), now, locale).text })
        : t("d4Chat.gate.accountAgeLater");
    case "followers":
      return t("d4Chat.gate.followersNext", { channel });
    case "subs":
      return t("d4Chat.gate.subsNext", { channel });
  }
}
