// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The held-message queue in the chat header (broadcaster and channel moderators only,
 * docs/testing/e7-selectors.md "Held messages"). The panel owns the queue state (live held
 * frames arrive on its socket); this component loads `chat.held.list`, shows the queue in a
 * popover and resolves messages, removing them at once and putting them back if the call fails.
 */
import { EmptyState, IconButton, RelativeTime, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@commonair/ui/components/popover";
import { toast } from "@commonair/ui/toast";
import { Cancel01Icon, MessageLock01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import type { ChatMessageFrame } from "../../chat/connection.ts";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api, errorCode } from "../../lib/api.ts";
import type { HeldAction, HeldState } from "./held-state.ts";

export interface HeldClient {
  list(channel: string): Promise<ChatMessageFrame[]>;
  resolve(channel: string, id: string, allow: boolean): Promise<void>;
}

export const apiHeldClient: HeldClient = {
  list: (channel) => api().chat.held.list({ channel }),
  resolve: async (channel, id, allow) => {
    await api().chat.held.resolve({ channel, id, allow });
  },
};

export interface HeldQueueProps {
  channel: string;
  state: HeldState;
  dispatch: React.Dispatch<HeldAction>;
  client?: HeldClient;
  /** Open initially (tests). */
  defaultOpen?: boolean;
}

type Load = "loading" | "loaded" | "failed";

export function HeldQueue({
  channel,
  state,
  dispatch,
  client = apiHeldClient,
  defaultOpen = false,
}: HeldQueueProps): React.JSX.Element {
  const [open, setOpen] = React.useState(defaultOpen);
  const [load, setLoad] = React.useState<Load>("loading");
  const seq = React.useRef(0);

  // Only the latest request may settle the state (an older, slower list must not win).
  const refresh = React.useCallback((): Promise<void> => {
    const mine = ++seq.current;
    return client.list(channel).then(
      (messages) => {
        if (mine !== seq.current) return;
        dispatch({ type: "loaded", messages });
        setLoad("loaded");
      },
      () => {
        if (mine === seq.current) setLoad((l) => (l === "loaded" ? l : "failed"));
      },
    );
  }, [channel, client, dispatch]);

  // Once on mount for the count on the button, again on every open (messages held before this
  // socket joined, or released by another moderator, are only in the list).
  React.useEffect(() => {
    let live = true;
    const mine = ++seq.current;
    client.list(channel).then(
      (messages) => {
        if (!live || mine !== seq.current) return;
        dispatch({ type: "loaded", messages });
        setLoad("loaded");
      },
      () => {
        if (live && mine === seq.current) setLoad("failed");
      },
    );
    return () => {
      live = false;
    };
  }, [channel, client, dispatch]);

  const resolve = async (message: ChatMessageFrame, allow: boolean) => {
    dispatch({ type: "remove", id: message.id });
    try {
      await client.resolve(channel, message.id, allow);
    } catch (err) {
      if (errorCode(err) === "CONFLICT") {
        toast.info(t("held.alreadyResolved"));
        return;
      }
      dispatch({ type: "restore", message });
      toastActionError(err, t("held.failed"));
    }
  };

  const count = state.items.length;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) return;
        setLoad((l) => (l === "failed" ? "loading" : l));
        void refresh();
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="held-queue-open"
            data-count={count}
            aria-label={t("held.open", { count })}
            className="gap-1 tabular-nums"
          />
        }
      >
        <HugeiconsIcon icon={MessageLock01Icon} strokeWidth={2} aria-hidden />
        <span aria-hidden>{count}</span>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        data-testid="held-queue"
        className="max-h-96 overflow-y-auto"
      >
        <PopoverHeader>
          <PopoverTitle>{t("held.title")}</PopoverTitle>
          <PopoverDescription>{t("held.description")}</PopoverDescription>
        </PopoverHeader>
        {count > 0 ? (
          <ul className="flex flex-col divide-y divide-border">
            {state.items.map((m) => (
              <HeldRow key={m.id} message={m} onResolve={(allow) => void resolve(m, allow)} />
            ))}
          </ul>
        ) : load === "loading" ? (
          <SkeletonGroup label={t("held.loading")}>
            <SkeletonText lines={3} />
          </SkeletonGroup>
        ) : load === "failed" ? (
          <p role="alert" className="text-muted-foreground">
            {t("held.loadFailed")}
          </p>
        ) : (
          <EmptyState
            data-testid="held-queue-empty"
            icon={MessageLock01Icon}
            title={t("held.empty")}
            description={t("held.emptyBody")}
            headingLevel={3}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function HeldRow({
  message,
  onResolve,
}: {
  message: ChatMessageFrame;
  onResolve: (allow: boolean) => void;
}): React.JSX.Element {
  const name = message.user.displayName;
  return (
    <li
      data-testid="held-message"
      data-id={message.id}
      data-username={message.user.username}
      className="flex min-w-0 items-start gap-2 py-2"
    >
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-semibold">{name}</span>
          <RelativeTime date={message.createdAt} className="shrink-0 text-muted-foreground" />
        </p>
        <p className={message.isAction ? "break-words italic" : "break-words"}>{message.body}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton
          data-testid="held-allow"
          label={t("held.allow", { name })}
          icon={Tick02Icon}
          size="icon-sm"
          onClick={() => onResolve(true)}
        />
        <IconButton
          data-testid="held-deny"
          label={t("held.deny", { name })}
          icon={Cancel01Icon}
          size="icon-sm"
          className="text-destructive"
          onClick={() => onResolve(false)}
        />
      </div>
    </li>
  );
}
