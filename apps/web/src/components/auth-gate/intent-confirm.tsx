// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Back from verification (or sign-in) on the page the visitor came from: a one-tap confirm of the
 * action they set out to take (README D2.1). It never acts on its own; "Not now" forgets it.
 * Counted with `trackUi("intent", confirm | dismiss, intent)`.
 */
import type { SignupIntent } from "@commonair/contracts/enums";
import { Button } from "@commonair/ui/components/button";
import { Popover, PopoverContent, PopoverDescription, PopoverTrigger } from "@commonair/ui/components/popover";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import {
  PENDING_INTENT_KEY,
  clearPendingIntent,
  parsePendingIntent,
  pendingIntentSnapshot,
  pendingMatches,
  type PendingIntent,
} from "./pending-intent.ts";
import { useGateLocation } from "./router-state.ts";

export interface PendingIntentState {
  pending: PendingIntent | null;
  /** The visitor tapped the action: forget the intent and count it (the caller acts). */
  confirm: () => void;
  dismiss: () => void;
}

// This tab's own writes (a `storage` event only reports other tabs').
const listeners = new Set<() => void>();
function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === PENDING_INTENT_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}
const noPending = (): string | null => null;

/**
 * The pending `intent` for this page, while `enabled` (signed in, and the action not already
 * done). The server render has none, so hydration agrees; the browser reads it after.
 */
export function usePendingIntent(intent: SignupIntent, enabled: boolean): PendingIntentState {
  const pathname = useGateLocation()?.pathname ?? null;
  const raw = React.useSyncExternalStore(subscribe, () => pendingIntentSnapshot(), noPending);
  const parsed = React.useMemo(() => parsePendingIntent(raw), [raw]);
  const pending = enabled && pathname !== null && pendingMatches(parsed, intent, pathname) ? parsed : null;
  const settle = (action: "confirm" | "dismiss") => {
    clearPendingIntent();
    for (const notify of listeners) notify();
    trackUi("intent", action, intent);
  };
  return { pending, confirm: () => settle("confirm"), dismiss: () => settle("dismiss") };
}

export interface IntentConfirmProps {
  open: boolean;
  /** "You're in. Follow Rivertide?" */
  message: string;
  /** The action's button inside the confirm (it carries the screen's one fill). */
  action: React.ReactNode;
  onDismiss: () => void;
  /** The page's own control for the action, which the confirm is anchored to. */
  trigger: React.ReactElement<Record<string, unknown>>;
  children?: React.ReactNode;
}

/** The confirm as a popover on the action's own control. */
export function IntentConfirm({
  open,
  message,
  action,
  onDismiss,
  trigger,
  children,
}: IntentConfirmProps): React.JSX.Element {
  return (
    <Popover open={open} onOpenChange={(next) => (next ? undefined : onDismiss())}>
      <PopoverTrigger render={trigger}>{children}</PopoverTrigger>
      <PopoverContent
        data-testid="intent-confirm"
        side="bottom"
        align="start"
        sideOffset={8}
        className="w-80 max-w-[calc(100vw-2rem)] gap-3 p-4 motion-reduce:animate-none"
      >
        <PopoverDescription className="text-sm/relaxed text-foreground">
          <output>{message}</output>
        </PopoverDescription>
        <div className="flex flex-wrap items-center gap-2">
          {action}
          <Button data-testid="intent-confirm-dismiss" variant="ghost" onClick={onDismiss}>
            {t("d2Gate.confirm.dismiss")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
