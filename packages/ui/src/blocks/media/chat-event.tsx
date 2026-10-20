// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { cva, type VariantProps } from "class-variance-authority";
import { MoneyAmount, type MoneyValue } from "../../primitives/money-amount.tsx";
import { cn } from "@commonair/ui/lib/utils";

const chatEventEdge = cva("", {
  variants: {
    tone: {
      accent: "border-channel-accent",
      success: "border-success",
      info: "border-info",
      warning: "border-warning",
    },
  },
  defaultVariants: { tone: "accent" },
});

/** The icon chip uses the same AA-checked pairs as `StatusBadge`. */
const chatEventIcon = cva("flex size-5 shrink-0 items-center justify-center", {
  variants: {
    tone: {
      accent: "bg-channel-accent text-channel-accent-foreground",
      success: "bg-success/10 text-success",
      info: "bg-info/10 text-info",
      warning: "bg-warning/10 text-warning",
    },
  },
  defaultVariants: { tone: "accent" },
});

export type ChatEventTone = NonNullable<VariantProps<typeof chatEventEdge>["tone"]>;

export interface ChatEventProps extends Omit<React.ComponentProps<"article">, "children"> {
  /** Decorative: `text` carries the meaning. */
  icon: IconSvgElement;
  /** One line saying what happened ("rivertide subscribed at Tier 2"). */
  text: React.ReactNode;
  tone?: ChatEventTone;
  /** Optional amount (tips), formatted with `<MoneyAmount>`. */
  amount?: MoneyValue;
  locale?: string;
  /** Optional body under the line (a tip message). */
  message?: React.ReactNode;
}

/**
 * A platform event inline in the chat log (subscriptions, gift subs, tips). An `article` like
 * `ChatMessage`, so the log reads it as one entry; the entrance fade only runs with motion allowed.
 */
export function ChatEvent({
  icon,
  text,
  tone,
  amount,
  locale,
  message,
  className,
  ...props
}: ChatEventProps): React.JSX.Element {
  return (
    <article
      data-slot="chat-event"
      data-tone={tone ?? "accent"}
      className={cn(
        "my-0.5 flex min-w-0 items-start gap-2 border-s-2 bg-muted px-2 py-1.5 motion-safe:animate-in motion-safe:fade-in-0",
        chatEventEdge({ tone }),
        className,
      )}
      {...props}
    >
      <span data-slot="chat-event-icon" aria-hidden className={chatEventIcon({ tone })}>
        <HugeiconsIcon icon={icon} strokeWidth={2} className="size-3.5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="min-w-0 break-words font-medium">
          {text}
          {amount && (
            <>
              {" "}
              <MoneyAmount value={amount} locale={locale} className="font-semibold" />
            </>
          )}
        </p>
        {message && <p className="min-w-0 break-words">{message}</p>}
      </div>
    </article>
  );
}
