// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/mod/$channel` (F23): what a streamer or a channel moderator keeps open while live. Chat with its
 * moderation actions (the embedded `ChatPanel` offers delete, timeout and ban to moderators), the
 * held-message queue inline, and the channel's recent moderator actions.
 *
 * Overhaul wave 5: the held queue is a `QueueLayout`, as the staff queues are (D7.5): the list
 * beside the open message at lg and up, the list alone below it (an open message replaces it, with
 * Back); j and k move between rows, Enter opens, e goes to Allow and Deny, ? lists the keys. Every
 * row still allows or denies in place, as before.
 *
 * The server decides who may see it: the page asks for the held queue (`chat.held.list`, moderator
 * only) before it shows anything, and a refusal renders the not-found state, the same page as a
 * channel that does not exist. Nothing here trusts the client's idea of who moderates.
 */
import type { dto } from "@commonair/contracts";
import { EmptyState, IconButton, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { QueueLayout, type QueueShortcutsCopy } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import { Cancel01Icon, MessageLock01Icon, Shield01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import type { z } from "zod";
import type { ChatMessageFrame } from "../../chat/connection.ts";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api, errorCode } from "../../lib/api.ts";
import { NotFoundState } from "../not-found.tsx";
import { StudioNote } from "../studio/note.tsx";
import { apiHeldClient, type HeldClient } from "./held-queue.tsx";
import { EMPTY_HELD, heldReducer } from "./held-state.ts";

export type ModActionDto = z.infer<typeof dto.ModActionView>;

export interface ModViewClient {
  held: HeldClient;
  modLog: (channel: string) => Promise<ModActionDto[]>;
}

/** How many recent mod actions the panel lists. */
export const MOD_LOG_LIMIT = 25;
/** The held queue has no socket here: it refreshes this often while the page is open. */
export const HELD_REFRESH_MS = 15_000;

export const apiModViewClient: ModViewClient = {
  held: apiHeldClient,
  modLog: async (channel) => (await api().safety.modLog({ channel, limit: MOD_LOG_LIMIT })).items,
};

/** Codes that mean "you may not moderate this channel" (or it does not exist): the page is not found. */
export function deniesAccess(err: unknown): boolean {
  const code = errorCode(err);
  return code === "FORBIDDEN" || code === "NOT_FOUND" || code === "UNAUTHORIZED";
}

type Access =
  | { state: "checking" }
  | { state: "denied" }
  | { state: "failed" }
  | { state: "ok"; held: ChatMessageFrame[] };

export interface ModViewProps {
  channel: string;
  /** The live chat with moderation actions (the route passes `ChatPanel`). */
  chat: React.ReactNode;
  client?: ModViewClient;
  /** The page header, rendered once access is confirmed (it lives in the route, F26). */
  header: React.ReactNode;
  /**
   * The route's page container around every state but "denied": the not-found state brings its own
   * container, and nesting it in the route's doubles the side gutter at 320 px.
   */
  frame?: (children: React.ReactNode) => React.ReactNode;
  /** Timers, for tests. */
  refreshMs?: number;
}

export function ModView({
  channel,
  chat,
  client = apiModViewClient,
  header,
  frame = (children) => children,
  refreshMs = HELD_REFRESH_MS,
}: ModViewProps): React.JSX.Element {
  const [access, setAccess] = React.useState<Access>({ state: "checking" });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    client.held.list(channel).then(
      (held) => {
        if (live) setAccess({ state: "ok", held });
      },
      (err: unknown) => {
        if (live) setAccess(deniesAccess(err) ? { state: "denied" } : { state: "failed" });
      },
    );
    return () => {
      live = false;
    };
  }, [channel, client, attempt]);

  if (access.state === "denied") return <NotFoundState data-testid="mod-view-denied" />;
  return (
    <>
      {frame(
        <ModViewBody
          access={access}
          channel={channel}
          chat={chat}
          client={client}
          header={header}
          refreshMs={refreshMs}
          retry={() => {
            setAccess({ state: "checking" });
            setAttempt((n) => n + 1);
          }}
        />,
      )}
    </>
  );
}

function ModViewBody({
  access,
  channel,
  chat,
  client,
  header,
  refreshMs,
  retry,
}: {
  access: Exclude<Access, { state: "denied" }>;
  channel: string;
  chat: React.ReactNode;
  client: ModViewClient;
  header: React.ReactNode;
  refreshMs: number;
  retry: () => void;
}): React.JSX.Element {
  if (access.state === "checking")
    return (
      <div data-testid="mod-view-checking" aria-busy="true">
        <SkeletonGroup label={t("studio.mod.checking")}>
          <SkeletonText lines={6} />
        </SkeletonGroup>
      </div>
    );
  if (access.state === "failed")
    return (
      <EmptyState
        data-testid="mod-view-failed"
        icon={Shield01Icon}
        title={t("studio.mod.loadFailed")}
        description={t("studio.mod.loadFailedHint")}
        action={
          <Button data-testid="empty-state-action" size="sm" onClick={retry}>
            {t("common.retry")}
          </Button>
        }
      />
    );
  return (
    <div data-testid="mod-view" data-channel={channel} className="flex min-w-0 flex-col gap-6">
      {header}
      {/* The held queue leads (the mockup's order): it is what waits on a moderator. */}
      <HeldPanel channel={channel} client={client.held} initial={access.held} refreshMs={refreshMs} />
      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-3">
        <section aria-label={t("studio.mod.chat")} className="flex min-w-0 flex-col lg:col-span-2">
          {chat}
        </section>
        <ModLogPanel channel={channel} client={client} />
      </div>
    </div>
  );
}

/** The `?` dialog's list; built per render so it follows the locale. */
export function heldShortcuts(): QueueShortcutsCopy {
  return {
    title: t("d7Admin.keys.title"),
    description: t("d7Admin.keys.description"),
    items: [
      { keys: ["j"], label: t("d7Admin.keys.next") },
      { keys: ["k"], label: t("d7Admin.keys.previous") },
      { keys: ["Enter"], label: t("d7Admin.keys.open") },
      { keys: ["e"], label: t("d7Admin.keys.decide") },
      { keys: ["?"], label: t("d7Admin.keys.help") },
    ],
  };
}

/** The held queue inline, as a QueueLayout: refreshed on a timer and on demand. */
export function HeldPanel({
  channel,
  client,
  initial,
  refreshMs,
}: {
  channel: string;
  client: HeldClient;
  initial: readonly ChatMessageFrame[];
  refreshMs: number;
}): React.JSX.Element {
  const [state, dispatch] = React.useReducer(heldReducer, EMPTY_HELD, (s) =>
    heldReducer(s, { type: "loaded", messages: initial }),
  );
  const [refreshing, setRefreshing] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      dispatch({ type: "loaded", messages: await client.list(channel) });
    } catch {
      // The next tick tries again; the rows already shown stay.
    } finally {
      setRefreshing(false);
    }
  }, [channel, client]);
  React.useEffect(() => {
    if (refreshMs <= 0) return;
    const handle = window.setInterval(() => void refresh(), refreshMs);
    return () => window.clearInterval(handle);
  }, [refresh, refreshMs]);

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

  // A message resolved here, by another moderator or released on refresh closes on its own.
  const open = openId === null ? null : (state.items.find((m) => m.id === openId) ?? null);
  const headingId = React.useId();
  return (
    <section
      data-testid="mod-held-panel"
      data-count={state.items.length}
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={headingId} className="font-display text-lg font-semibold">
            {t("held.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("held.description")}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          data-testid="mod-held-refresh"
          disabled={refreshing}
          aria-busy={refreshing || undefined}
          onClick={() => void refresh()}
        >
          {t("studio.mod.refresh")}
        </Button>
      </div>
      <QueueLayout
        data-testid="mod-held-queue"
        listLabel={t("held.title")}
        detailLabel={t("w5Studio.mod.detail")}
        // Only the count is live: the list is replaced on every refresh and would be re-read.
        count={
          <output data-testid="mod-held-status">{t("studio.mod.heldCount", { count: state.items.length })}</output>
        }
        list={
          state.items.length === 0 ? (
            <EmptyState
              data-testid="held-queue-empty"
              icon={MessageLock01Icon}
              title={t("held.empty")}
              description={t("held.emptyBody")}
              headingLevel={3}
            />
          ) : (
            <ul aria-label={t("held.title")} className="flex flex-col divide-y divide-border">
              {state.items.map((m) => (
                <ModHeldRow
                  key={m.id}
                  message={m}
                  open={m.id === open?.id}
                  onOpen={() => setOpenId(m.id)}
                  onResolve={(allow) => void resolve(m, allow)}
                />
              ))}
            </ul>
          )
        }
        detail={open ? <HeldDetail message={open} onResolve={(allow) => void resolve(open, allow)} /> : null}
        detailEmpty={state.items.length === 0 ? t("w5Studio.mod.none") : t("w5Studio.mod.pick")}
        onBack={() => setOpenId(null)}
        backLabel={t("w5Studio.mod.back")}
        shortcuts={heldShortcuts()}
      />
      <p className="text-xs text-muted-foreground">{t("d7Admin.keys.hint")}</p>
    </section>
  );
}

/** One held message: who and what, Review to open it, and Allow and Deny in place. */
function ModHeldRow({
  message,
  open,
  onOpen,
  onResolve,
}: {
  message: ChatMessageFrame;
  open: boolean;
  onOpen: () => void;
  onResolve: (allow: boolean) => void;
}): React.JSX.Element {
  const name = message.user.displayName;
  return (
    <li
      data-testid="held-message"
      data-id={message.id}
      data-username={message.user.username}
      data-open={open ? "true" : "false"}
      className="flex min-w-0 items-start gap-2 py-2"
    >
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-1.5 text-sm">
          <span className="truncate font-semibold">{name}</span>
          <RelativeTime date={message.createdAt} className="shrink-0 text-muted-foreground" />
        </p>
        <p
          className={message.isAction ? "line-clamp-2 text-sm break-words italic" : "line-clamp-2 text-sm break-words"}
        >
          {message.body}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          size="sm"
          variant={open ? "default" : "outline"}
          aria-pressed={open}
          aria-label={t("w5Studio.mod.openLabel", { name })}
          // QueueLayout's j/k move between these; Enter opens the focused one.
          data-queue-row=""
          data-testid="mod-held-open"
          onClick={onOpen}
        >
          {t("w5Studio.mod.open")}
        </Button>
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

/** The open held message in full, with the decision (`e` focuses it). */
function HeldDetail({
  message,
  onResolve,
}: {
  message: ChatMessageFrame;
  onResolve: (allow: boolean) => void;
}): React.JSX.Element {
  const name = message.user.displayName;
  return (
    <article data-testid="mod-held-detail" data-id={message.id} className="flex min-w-0 flex-col gap-3">
      <header className="flex min-w-0 flex-col gap-1">
        <h3 className="font-display text-base font-semibold break-words">{name}</h3>
        <p className="flex min-w-0 flex-wrap items-baseline gap-1.5 text-sm text-muted-foreground">
          <span className="break-all">@{message.user.username}</span>
          <RelativeTime date={message.createdAt} />
        </p>
      </header>
      <p className={message.isAction ? "break-words whitespace-pre-wrap italic" : "break-words whitespace-pre-wrap"}>
        {message.body}
      </p>
      <div data-queue-decision="" className="flex flex-wrap gap-2">
        <Button
          data-testid="mod-held-detail-allow"
          variant="outline"
          size="sm"
          aria-label={t("held.allow", { name })}
          onClick={() => onResolve(true)}
        >
          <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
          {t("w5Studio.mod.allow")}
        </Button>
        <Button
          data-testid="mod-held-detail-deny"
          variant="outline"
          size="sm"
          aria-label={t("held.deny", { name })}
          onClick={() => onResolve(false)}
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
          {t("w5Studio.mod.deny")}
        </Button>
      </div>
    </article>
  );
}

/** The channel's latest moderator actions, newest first. */
export function ModLogPanel({ channel, client }: { channel: string; client: ModViewClient }): React.JSX.Element {
  const [items, setItems] = React.useState<ModActionDto[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const load = React.useCallback(
    () =>
      client.modLog(channel).then(
        (list) => {
          setItems(list);
          setFailed(false);
        },
        () => setFailed(true),
      ),
    [channel, client],
  );
  React.useEffect(() => {
    void load();
  }, [load]);
  return (
    <Card data-testid="mod-log" aria-busy={items === null && !failed}>
      <CardHeader>
        <CardTitle>{t("studio.mod.logTitle")}</CardTitle>
        <CardDescription>{t("studio.mod.logHint")}</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" data-testid="mod-log-refresh" onClick={() => void load()}>
            {t("studio.mod.refresh")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {failed ? (
          <StudioNote role="alert">{t("studio.mod.logFailed")}</StudioNote>
        ) : items === null ? (
          <SkeletonGroup label={t("studio.mod.logLoading")}>
            <SkeletonText lines={4} />
          </SkeletonGroup>
        ) : items.length === 0 ? (
          <EmptyState
            data-testid="mod-log-empty"
            icon={Shield01Icon}
            title={t("studio.mod.logEmpty")}
            description={t("studio.mod.logEmptyHint")}
            headingLevel={3}
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {items.map((a) => (
              <li
                key={a.id}
                data-testid="mod-log-entry"
                data-action={a.action}
                className="flex min-w-0 flex-col gap-1 py-2 text-sm"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <StatusBadge tone={actionTone(a.action)}>{t("studio.mod.action", { action: a.action })}</StatusBadge>
                  <RelativeTime date={a.createdAt} className="text-muted-foreground" />
                </span>
                <span className="break-words">{modActionLine(a)}</span>
                {a.reason ? <span className="break-words text-muted-foreground">{a.reason}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Who acted on whom; an action without a moderator (filters, automatic expiry) says so. */
export function modActionLine(a: Pick<ModActionDto, "moderator" | "target">): string {
  const moderator = a.moderator?.username;
  if (moderator)
    return a.target
      ? t("studio.mod.byOn", { moderator, target: a.target.username })
      : t("studio.mod.by", { moderator });
  return a.target ? t("studio.mod.autoOn", { target: a.target.username }) : t("studio.mod.auto");
}

function actionTone(action: ModActionDto["action"]): "danger" | "warning" | "neutral" {
  if (action === "ban" || action === "suspend_channel" || action === "suspend_user" || action === "end_stream")
    return "danger";
  if (action === "timeout" || action === "delete_message" || action === "clear_chat" || action === "warn")
    return "warning";
  return "neutral";
}
