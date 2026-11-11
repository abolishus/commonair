// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one-tap confirms for the chat and predict sign-up intents (README D2.1, wave 3). Their
 * targets live in the chat column (d4-chat's), so this module gives that owner a typed hook
 * (`useIntentConfirm`) and two ready confirms to drop beside the composer and the prediction
 * strip. Like Follow's, a confirm never acts on its own: "Say hi in chat" only focuses the
 * composer, "Join the prediction" only brings the open prediction into view and focuses it.
 */
import type { SignupIntent } from "@commonair/contracts/enums";
import { Button } from "@commonair/ui/components/button";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { usePendingIntent, type PendingIntentState } from "./intent-confirm.tsx";

export type ConfirmableIntent = Extract<SignupIntent, "follow" | "chat" | "support" | "predict" | "clip" | "watch">;

export interface IntentConfirmHandle extends Omit<PendingIntentState, "confirm"> {
  /** Forget the intent, count it, then run the page's handler. */
  confirm: () => void;
}

/**
 * The pending `intent` on this page while `enabled`, with `onConfirm` run on the tap. The
 * caller renders the confirm; `IntentConfirmCard` is the inline one.
 */
export function useIntentConfirm(
  intent: ConfirmableIntent,
  enabled: boolean,
  onConfirm: () => void,
): IntentConfirmHandle {
  const state = usePendingIntent(intent, enabled);
  return {
    pending: state.pending,
    dismiss: state.dismiss,
    confirm: () => {
      state.confirm();
      onConfirm();
    },
  };
}

export interface IntentConfirmCardProps {
  intent: ConfirmableIntent;
  /** "You're in. Say hi in chat?" */
  message: string;
  actionLabel: string;
  handle: IntentConfirmHandle;
  className?: string;
}

/** The confirm inline, where there is no single control to anchor a popover to. */
export function IntentConfirmCard({
  intent,
  message,
  actionLabel,
  handle,
  className,
}: IntentConfirmCardProps): React.JSX.Element | null {
  if (!handle.pending) return null;
  return (
    <section
      data-testid="intent-confirm"
      data-intent={intent}
      aria-label={message}
      className={className ?? "flex flex-col gap-2 bg-card p-3 text-sm ring-1 ring-border"}
    >
      <output className="text-foreground">{message}</output>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid={`intent-confirm-${intent}`}
          data-filled-cta=""
          variant="brand"
          size="sm"
          onClick={handle.confirm}
        >
          {actionLabel}
        </Button>
        <Button data-testid="intent-confirm-dismiss" variant="ghost" size="sm" onClick={handle.dismiss}>
          {t("d4Follow.confirm.dismiss")}
        </Button>
      </div>
    </section>
  );
}

/**
 * Back from sign-up with `intent=chat`: "Say hi in chat" focuses the composer (`onSayHi`), and
 * nothing is sent. Render it above the composer while the viewer can chat.
 */
export function ChatIntentConfirm({
  canChat,
  onSayHi,
  className,
}: {
  /** Signed in and the composer is usable now. */
  canChat: boolean;
  onSayHi: () => void;
  className?: string;
}): React.JSX.Element | null {
  const handle = useIntentConfirm("chat", canChat, onSayHi);
  return (
    <IntentConfirmCard
      intent="chat"
      message={t("d4Follow.confirm.chat")}
      actionLabel={t("d4Follow.confirm.chatAction")}
      handle={handle}
      {...(className ? { className } : {})}
    />
  );
}

/**
 * Back from sign-up with `intent=predict`: "Join the prediction" scrolls the open prediction into
 * view and focuses it (`onJoin`); no points are placed. Shown only while a prediction is open.
 */
export function PredictionIntentConfirm({
  predictionOpen,
  onJoin,
  className,
}: {
  /** Signed in and a prediction is open for entries. */
  predictionOpen: boolean;
  onJoin: () => void;
  className?: string;
}): React.JSX.Element | null {
  const handle = useIntentConfirm("predict", predictionOpen, onJoin);
  return (
    <IntentConfirmCard
      intent="predict"
      message={t("d4Follow.confirm.predict")}
      actionLabel={t("d4Follow.confirm.predictAction")}
      handle={handle}
      {...(className ? { className } : {})}
    />
  );
}

/** Scroll an element into view (respecting reduced motion) and focus it: the predict confirm's target. */
export function revealAndFocus(el: HTMLElement | null): void {
  if (!el) return;
  const reduce =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  if (!el.hasAttribute("tabindex") && !el.matches("a,button,input,select,textarea")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}
