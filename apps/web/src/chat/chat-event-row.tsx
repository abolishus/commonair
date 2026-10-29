// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChatEvent } from "@commonair/ui/blocks/media";
import { GiftIcon, MoneyBag02Icon, Rocket01Icon, StarIcon } from "@hugeicons/core-free-icons";
import type * as React from "react";
import { chatEventText, type ChatEventView } from "./events.ts";

const ICONS = {
  "channel.subscribe": StarIcon,
  "channel.subscription.gift": GiftIcon,
  "channel.tip": MoneyBag02Icon,
  "channel.raid": Rocket01Icon,
} as const;

/**
 * One platform event in the chat log (`chat-event` in docs/testing/e4b-selectors.md; incoming
 * raids in e8-selectors.md).
 */
export function ChatEventRow({ event }: { event: ChatEventView }): React.JSX.Element {
  return (
    <ChatEvent
      data-testid="chat-event"
      data-type={event.type}
      data-user={event.user}
      data-tier={event.tier ?? undefined}
      data-cents={event.amount?.cents}
      data-total={event.total ?? undefined}
      data-viewers={event.viewers ?? undefined}
      icon={ICONS[event.type]}
      tone={event.type === "channel.tip" ? "success" : "accent"}
      text={chatEventText(event)}
      amount={event.amount ?? undefined}
      message={event.message ?? undefined}
    />
  );
}
