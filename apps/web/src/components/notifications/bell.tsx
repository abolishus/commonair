// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { IconButton, formatNumber, useLocale } from "@commonair/ui";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@commonair/ui/components/popover";
import { Notification03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { errorCode } from "../../lib/api.ts";
import {
  type InboxClient,
  UNREAD_MIN_GAP_MS,
  UNREAD_POLL_MS,
  type UnreadCount,
  afterReadingOne,
  inboxClient,
} from "../../lib/notifications.ts";
import { NotificationInbox } from "./inbox.tsx";

/**
 * Polls `notifications.unreadCount` every minute while the tab is visible, and on focus and when
 * the tab comes back. A hidden tab never polls; an UNAUTHORIZED answer (signed out elsewhere) stops it.
 */
export function useUnreadCount(client: InboxClient): {
  unread: UnreadCount;
  setUnread: React.Dispatch<React.SetStateAction<UnreadCount>>;
  refresh: () => void;
} {
  const [unread, setUnread] = React.useState<UnreadCount>({ count: 0, capped: false });
  const stopped = React.useRef(false);
  const inFlight = React.useRef(false);
  const lastAt = React.useRef(0);

  const fetchNow = React.useCallback(
    async (force: boolean) => {
      if (stopped.current || inFlight.current) return;
      if (!force && Date.now() - lastAt.current < UNREAD_MIN_GAP_MS) return;
      inFlight.current = true;
      lastAt.current = Date.now();
      await client.unreadCount().then(
        (u) => setUnread(u),
        (err: unknown) => {
          if (errorCode(err) === "UNAUTHORIZED") stopped.current = true;
        },
      );
      inFlight.current = false;
    },
    [client],
  );

  React.useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      if (timer !== null || stopped.current) return;
      timer = setInterval(() => {
        if (stopped.current) stop();
        else void fetchNow(true);
      }, UNREAD_POLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void fetchNow(false);
        start();
      } else stop();
    };
    const onFocus = () => void fetchNow(false);
    if (document.visibilityState === "visible") {
      void fetchNow(true);
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchNow]);

  const refresh = React.useCallback(() => void fetchNow(true), [fetchNow]);
  return { unread, setUnread, refresh };
}

export interface NotificationBellProps {
  /** Tests pass a fixture client; the app uses the API. */
  client?: InboxClient;
}

/** The header bell: unread count and a popover inbox (ADR 0028). Signed in only (site-chrome). */
export function NotificationBell({ client: given }: NotificationBellProps = {}): React.JSX.Element {
  const client = React.useMemo(() => given ?? inboxClient(), [given]);
  const { locale } = useLocale();
  const { unread, setUnread, refresh } = useUnreadCount(client);
  const [open, setOpen] = React.useState(false);
  // Remounts the list on every open, so it always starts from the newest page.
  const [openCount, setOpenCount] = React.useState(0);

  const shown = formatNumber(unread.count, locale);
  const label = unread.capped
    ? t("notifications.bell.labelCapped", { count: shown })
    : t("notifications.bell.label", { count: unread.count });

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) return;
        setOpenCount((n) => n + 1);
        refresh();
      }}
    >
      <PopoverTrigger
        render={
          <IconButton
            data-testid="notification-bell"
            data-unread={unread.count}
            data-capped={unread.capped ? "true" : "false"}
            label={label}
            tooltip={t("notifications.title")}
            tooltipSide="bottom"
            className="relative"
          >
            <HugeiconsIcon icon={Notification03Icon} strokeWidth={2} aria-hidden />
            {unread.count > 0 && (
              <span
                data-testid="notification-bell-badge"
                aria-hidden
                className="pointer-events-none absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-2xs leading-none font-medium text-primary-foreground tabular-nums"
              >
                {unread.capped ? t("notifications.bell.capped", { count: shown }) : shown}
              </span>
            )}
          </IconButton>
        }
      />
      <PopoverContent align="end" className="w-72 gap-2 p-0 sm:w-80">
        <PopoverHeader className="px-3 pt-3">
          <PopoverTitle>{t("notifications.title")}</PopoverTitle>
        </PopoverHeader>
        <NotificationInbox
          key={openCount}
          client={client}
          onReadOne={() => {
            const next = afterReadingOne(unread);
            if (next) setUnread(next);
            else refresh();
          }}
          onReadAll={() => setUnread({ count: 0, capped: false })}
          onRefreshCount={refresh}
          onNavigate={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
