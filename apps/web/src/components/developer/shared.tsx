// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pieces the developer pages share: copy buttons, the one-time secret dialog, live paged lists. */
import { IconButton } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button } from "@commonair/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@commonair/ui/components/dialog";
import { toast } from "@commonair/ui/toast";
import { Copy01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { usePolling } from "../interact-studio/shared.tsx";
import type { Page } from "./client.ts";
import { mergeFirstPage } from "./model.ts";

/** An icon button that copies `value` (a client id, a secret, a token) to the clipboard. */
export function CopyButton({
  value,
  label,
  "data-testid": testId,
}: {
  value: string;
  label: string;
  "data-testid"?: string;
}): React.JSX.Element {
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("developer.copied"));
    } catch {
      toast.error(t("developer.copyFailed"));
    }
  };
  return (
    <IconButton
      type="button"
      icon={Copy01Icon}
      label={label}
      tooltip={label}
      size="icon-sm"
      data-testid={testId}
      onClick={() => void copy()}
    />
  );
}

/**
 * The client secret, once (after a create or a rotation). The parent holds it only while this
 * dialog is open and drops it on close: it is never stored anywhere else, and never logged.
 */
export function SecretDialog({
  secret,
  onDone,
}: {
  secret: { clientId: string; clientSecret: string } | null;
  onDone: () => void;
}): React.JSX.Element {
  return (
    <Dialog
      open={secret !== null}
      onOpenChange={(open) => {
        if (!open) onDone();
      }}
    >
      <DialogContent className="sm:max-w-lg" data-testid="devapp-secret" data-client-id={secret?.clientId ?? ""}>
        <DialogHeader>
          <DialogTitle>{t("developer.secret.title")}</DialogTitle>
          <DialogDescription>{t("developer.secret.intro")}</DialogDescription>
        </DialogHeader>
        {secret ? (
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t("developer.app.clientId")}</span>
              <code className="text-sm break-all">{secret.clientId}</code>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t("developer.secret.label")}</span>
              <div className="flex min-w-0 items-center gap-2">
                <code
                  data-testid="devapp-secret-value"
                  className="min-w-0 flex-1 rounded-sm bg-muted p-2 text-sm break-all select-all"
                >
                  {secret.clientSecret}
                </code>
                <CopyButton
                  value={secret.clientSecret}
                  label={t("developer.secret.copy")}
                  data-testid="devapp-secret-copy"
                />
              </div>
            </div>
            <AlertCallout tone="warning" description={t("developer.secret.once")} />
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" data-testid="devapp-secret-done" onClick={onDone}>
            {t("developer.secret.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface LiveList<T> {
  /** null until the first page arrives. */
  items: T[] | null;
  failed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  /** Reload the first page and merge it into what is shown (older pages stay). */
  refresh: () => Promise<void>;
  /** Take a row off the screen now (a delete): `refresh()` alone keeps rows missing from page one. */
  drop: (id: string) => void;
  retry: () => void;
}

/**
 * A cursor-paged list that can refresh in place: `refresh()` (and the poll, while `pollMs` is
 * set) merges a fresh first page over the rows shown, so pages loaded with "Load more" stay.
 */
export function useLiveList<T extends { id: string }>(
  key: string,
  load: (cursor: string | undefined) => Promise<Page<T>>,
  opts: {
    pollMs?: number | null;
    /** Poll only while this holds for the rows shown (default: always). */
    pollWhile?: (items: readonly T[]) => boolean;
    onMoreError?: (err: unknown) => void;
  } = {},
): LiveList<T> {
  const [state, setState] = React.useState<{
    key: string;
    items: T[] | null;
    cursor: string | null;
    paged: boolean;
    failed: boolean;
  }>({ key, items: null, cursor: null, paged: false, failed: false });
  const [loadingMore, setLoadingMore] = React.useState(false);
  const loadRef = React.useRef(load);
  React.useEffect(() => {
    loadRef.current = load;
  });
  const seq = React.useRef(0);

  const refresh = React.useCallback(async (): Promise<void> => {
    const id = ++seq.current;
    try {
      const page = await loadRef.current(undefined);
      if (id !== seq.current) return;
      setState((prev) => {
        const same = prev.key === key && prev.items !== null;
        const items = same && prev.items ? mergeFirstPage(page.items, prev.items) : page.items;
        // Once more pages were loaded, the cursor is the last loaded page's, not the fresh first page's.
        const cursor = same && prev.paged ? prev.cursor : page.nextCursor;
        return { key, items, cursor, paged: same && prev.paged, failed: false };
      });
    } catch {
      if (id !== seq.current) return;
      setState((prev) =>
        prev.key === key ? { ...prev, failed: true } : { key, items: null, cursor: null, paged: false, failed: true },
      );
    }
  }, [key]);

  React.useEffect(() => {
    void refresh();
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [refresh]);

  const current = state.key === key ? state : { key, items: null, cursor: null, paged: false, failed: false };
  const pollMs = opts.pollMs ?? null;
  const pollWhile = opts.pollWhile;
  const polling = pollMs !== null && current.items !== null && (pollWhile ? pollWhile(current.items) : true);
  usePolling(polling, pollMs ?? 0, refresh);

  const onMoreError = opts.onMoreError;
  const loadMore = (): void => {
    const cursor = current.cursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    loadRef
      .current(cursor)
      .then((page) =>
        setState((prev) =>
          prev.key === key && prev.items
            ? {
                ...prev,
                items: [...prev.items, ...page.items.filter((r) => !prev.items?.some((x) => x.id === r.id))],
                cursor: page.nextCursor,
                paged: true,
              }
            : prev,
        ),
      )
      .catch((err: unknown) => onMoreError?.(err))
      .finally(() => setLoadingMore(false));
  };

  return {
    items: current.items,
    failed: current.failed,
    hasMore: current.cursor !== null,
    loadingMore,
    loadMore,
    refresh,
    drop: (id: string) =>
      setState((prev) =>
        prev.key === key && prev.items ? { ...prev, items: prev.items.filter((r) => r.id !== id) } : prev,
      ),
    retry: () => void refresh(),
  };
}

/** "Load more" under a paged list, when there is more. */
export function LoadMore({
  list,
  "data-testid": testId,
}: {
  list: Pick<LiveList<{ id: string }>, "hasMore" | "loadingMore" | "loadMore">;
  "data-testid"?: string;
}): React.JSX.Element | null {
  if (!list.hasMore) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="self-start"
      data-testid={testId}
      disabled={list.loadingMore}
      onClick={list.loadMore}
    >
      {t("developer.loadMore")}
    </Button>
  );
}

/** A failed load with its retry button. */
export function LoadError({
  message,
  onRetry,
  "data-testid": testId,
}: {
  message: string;
  onRetry: () => void;
  "data-testid"?: string;
}): React.JSX.Element {
  return (
    <AlertCallout
      tone="danger"
      live
      description={message}
      data-testid={testId}
      action={
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t("developer.retry")}
        </Button>
      }
    />
  );
}
