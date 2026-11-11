// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatRelativeTime, useLocale } from "@commonair/ui";
import type * as React from "react";
import type { GateReason } from "../../chat/gate-reason.ts";
import { durationLabel } from "../../chat/modes.ts";
import { t } from "../../i18n/index.ts";
import { ResendVerification } from "../resend-verification.tsx";

/**
 * Why the viewer cannot chat yet and what to do about it, in the composer row before they type
 * (`chat-composer-gate`, ux-journeys J3-d). One reason at a time, the first the server would give.
 */
export function ComposerGate({
  reason,
  channelName,
  email,
  now,
}: {
  reason: GateReason;
  channelName: string;
  /** The viewer's address, for "Resend verification email"; omitted when unknown. */
  email?: string | undefined;
  /** The page's clock (ms), for when an account is old enough. */
  now: number;
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
    </section>
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
